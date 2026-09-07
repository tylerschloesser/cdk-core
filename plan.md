# cdk-core — shared CDK constructs and Claude skills for PR-previewed, Google-authed personal sites

> ## Status — 2026-09-06
>
> **Epochs 0 through 6 are complete. The plan is done, and every acceptance criterion is
> met.** `https://cdk-core.ty.ler.dev` is **live**, deployed by `deploy.yml` on every push to
> `main`. **Every PR on this repo gets a preview**, torn down on close with a daily
> `cdk-core sweep` behind it. **Auth is real** — Google login on production and on previews
> through the bounce, Claude signing into a preview with no browser, and no password path in
> prod. **The package is published**: `@tylerschloesser/cdk-core@0.1.0` is on public npm, and
> **`0.1.1` was published from CI by trusted publishing** — no token, no passkey prompt, with a
> SLSA provenance attestation. The marketplace now ships **two** plugins: `cdk-core` (three
> skills) and `epochs` (the session mechanism itself).
>
> **Epoch 6 was the hardening pass, and it was mostly measurement.** Almost nothing about the
> system changed; what changed is that the claims are now numbers. The sweeper deleted real
> resources for the first time (A8). Two PR deploys raced. A workflow was cancelled mid-deploy
> and a branch was force-deleted, both deliberately. KVS propagation, router compute and router
> latency all have medians and ranges. Three of the four failure cases D3 reasoned about have
> now been run.
>
> Alive in the account: `CdkCoreShared`, `CdkCorePreview` (preview pool `us-east-1_D9US7hu40` +
> the `claude` machine user), `CdkCoreSite` (prod pool `us-east-1_havW5h4hk`),
> `CdkCoreGithubOidc`, two Secrets Manager secrets, and an account-wide $10/month budget —
> all unchanged by Epoch 6. `pnpm verify`, `pnpm dev` and `pnpm e2e` still need no credentials,
> and neither does `consumer-smoke.sh`. Epoch 6 is **PR #10**; `CdkCore-pr-10` is alive only
> because that PR is open, and `pr-teardown.yml` takes it on merge. Every other stack Epoch 6
> created (`-pr-3`, `-4`, `-9`, `-11`) is gone, three of them **to the sweeper itself**.
>
> **Measured against the [acceptance criteria](#acceptance-criteria): all eight are met.** A1,
> A2, A4, A6 and A7 in earlier epochs and unchanged. A3 at 45 non-import CDK lines against a
> target of 60 — though its human-actions half is still unmeasured, now by decision rather than
> omission. A5 met in Epoch 5 on the second attempt. **A8 met in Epoch 6**, and it is the one
> that took a deliberately broken account to prove: three real stacks, one orphaned key and one
> orphaned prefix, all reclaimed by a single sweep.
>
> Corrections made against measurement or a failing run, each marked **`[revised]`** in place:
>
> 1. **Epoch 1 deliverables — `packages/cdk-core` is consumed as built `dist/`, not as
>    source.** Its exports map is the contract an npm consumer resolves, so it cannot be
>    imported as TypeScript the way `thai.ler.dev`'s packages are. Forces `.js` specifiers
>    inside `src/`, project references from `apps/*`, and a build step at the head of
>    `pnpm dev`. Details in `.claude/rules/typescript-config.md`.
> 2. **Epoch 1 deliverables — the `e2e` package's script is `e2e`, not `test`.** Named `test`
>    it was swept into `pnpm -r run test` inside `pnpm verify`, running the browser suite
>    twice per CI job. Browsers install with `pnpm --filter e2e exec playwright install
>    chromium`; a bare `pnpm exec playwright` from the root cannot find the binary.
> 3. **Epoch 1 acceptance — `pnpm dev` startup measured at 1.14 s warm / 2.85 s cold**
>    (medians of 7 interleaved samples; ranges 0.91–1.15 and 2.63–3.70). Budget was 10 s, so
>    A4 has ~3x headroom even cold. Numbers in `progress.md`.
> 4. **Construct API — `aws-cdk-lib` and `constructs` are *optional* peer dependencies, and
>    `auth/server` types Hono structurally.** A consumer that only wants `auth/browser` must
>    not have to install CDK, and the package must not pin a consumer's Hono major.
>    **[Epoch 4] `aws-jwt-verify` is the exception**: a real `dependencies` entry, because a
>    Lambda importing `auth/server` from the published tarball must get a working verifier.
>    **[Epoch 5] Confirmed from the published tarball**, which carries exactly
>    `{"aws-jwt-verify":"^5.2.1"}`.
> 5. **D1 — confirmed, no fallback needed.** An inline `originAccessControlConfig
>    {originType:'lambda'}` on `cf.updateRequestOrigin()` does SigV4-sign a request to an
>    `AWS_IAM` `RESPONSE_STREAM` function URL that is not an origin of the distribution.
>    Proven by hand before any construct was written; the `AuthType: NONE` + secret-header plan
>    B is dead. Two hard constraints came with it: **`await` may not appear inside a call's
>    argument list** in `cloudfront-js-2.0` (a syntax error surfacing only as a 503 at the
>    edge), and **both `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction` are required** —
>    either alone is a 403, measured in both directions.
> 6. **D10 — confirmed.** The rewritten `request.uri` is part of the cache key: two `pr-<n>/`
>    prefixes served the same viewer path with different bodies, both from cache, with query
>    strings excluded from the policy. One shared preview bucket; no per-PR bucket.
> 7. **D2 — the ETag-mismatch code is `ValidationException`, and deleting a missing key
>    succeeds.** Both were inferred; both are now measured. The handler still retries on
>    `ConflictException` too, since the mapping is undocumented. Separately, the bundled
>    handler **must import `@aws-sdk/signature-v4a`** or every KVS call fails at `describe` —
>    D2's SigV4A note in its concrete form, and it broke the first PR-stack deploy.
> 8. **Epoch 2 deliverables — one `BucketDeployment` for a preview, not two.** Two sharing a
>    prefix with `prune: true` fight over each other's files, and a second custom-resource
>    invocation sits on the critical path of every push for a caching win a short-lived preview
>    never collects. Everything is `public, max-age=0, must-revalidate` plus a
>    `/pr-<n>/*` invalidation. `Site` got the real split in Epoch 3.
> 9. **Architecture — the SPA fallback serves the shell, it does not append `index.html`.**
>    Rewriting `/auth/callback` to `<path>/index.html` made every deep client route **403**
>    (not 404: an OAC bucket policy grants `s3:GetObject` and not `s3:ListBucket`). Epoch 4
>    would have hit this on its first Google login.
> 10. **Construct API — `GithubDeployRoleProps` gained `ownerId` and `repoId`.** With only
>    `repo` there is no way to build GitHub's immutable
>    `repo:<owner>@<ownerId>/<name>@<repoId>:…` subject, and the alternative — a wildcard on the
>    owner id — would trust any account that later takes the name, which is the exact thing the
>    immutable form exists to prevent. Both forms are trusted when both ids are given.
> 11. **Construct API — `distributionOverrides` really cannot replace the behaviors now.** It
>    was spread *last* on `PreviewSite`, so it could replace anything, contradicting its own doc
>    comment. `safeDistributionOverrides()` strips `defaultBehavior`, `additionalBehaviors`,
>    `domainNames` and `certificate`; the rest is spread before them so `priceClass` and friends
>    still win over the construct's defaults.
> 12. **Epoch 3 — the sweep CLI is a bundled *CommonJS* artifact, and the package has a
>    `prepare` script.** Two failures no unit test could reach. An ESM bundle of the AWS SDK
>    clients builds clean and dies on the first call with `Dynamic require of "node:https" is
>    not supported`. And `pnpm exec cdk-core sweep` in CI failed with `Command "cdk-core" not
>    found`, because pnpm links a workspace bin only if the target exists **at install time**
>    and re-installing afterwards does not repair it (`--force` included, all four combinations
>    measured). See `.claude/rules/typescript-config.md`.
> 13. **Epoch 3 — `pr-teardown.yml` needs `GH_REPO`.** With no checkout, `gh pr comment` has no
>    git remote to infer the repository from and exits 1. Having no checkout is the point of
>    that workflow, so the fix is the env var, not a checkout step.
> 14. **Epoch 3 — the deploy role's IAM reads the KVS ARN and bucket name with
>    `ssm.StringParameter.valueFromLookup`, so `infra/cdk.context.json` is committed.** A
>    `valueForStringParameter` dynamic reference cannot appear inside an IAM resource ARN.
> 15. **Epoch 3 — `CdkCoreSite` was created by hand first, then re-deployed by `deploy.yml`.**
>    `workflow_dispatch` requires the workflow on the default branch, and a first CloudFront
>    create is a four-minute round trip to discover a construct bug in. Both paths are green;
>    the plan's ordering assumed the workflow could run before it was merged. **Epoch 4 did the
>    same thing for the same reason**, and for one more: its acceptance test needs a live prod
>    pool to prove the negative against.
> 16. **Epoch 3 — the deploy role trusts `refs/heads/main` and `pull_request` and nothing
>    else**, so a `workflow_dispatch` from any other branch is refused at
>    `sts:AssumeRoleWithWebIdentity`. Correct, and worth knowing before trying to test a
>    workflow change from a branch.
> 17. **Epoch 4 — `authFlows: {}` does the opposite of what the plan intended.** CDK's
>    `configureAuthFlows` returns `undefined` for an *empty* `authFlows` as well as an absent
>    one, omitting `ExplicitAuthFlows` — and an omitted list makes Cognito apply its legacy
>    defaults, which include `ALLOW_USER_SRP_AUTH`. D6's "structurally impossible" rests
>    entirely on that list, so it is pinned on the L1 and asserted in `site.test.ts`.
> 18. **Epoch 4 — a preview API must trust *two* app clients.** A token's `aud` is the client
>    that minted it, so the machine user's tokens carry `machine` and a human's carry `browser`;
>    a verifier given one 401s every call made with the other. Measured. `AUTH_CLIENT_ID` is a
>    comma-separated allowlist and `PreviewSite` publishes `authMachineClientId`. The isolation
>    that matters is unchanged: it is the *pool*, enforced by `iss`.
> 19. **Epoch 4 — `PreviewSite` publishes `authDomain`, and `PreviewDeployment` gained
>    `auth?: boolean`.** The hosted-UI host is not derivable from the issuer, and a PR stack
>    cannot detect whether the site has a pool — `valueForStringParameter` on a missing
>    parameter fails the *deploy*, not the synth, so there is nothing to branch on.
> 20. **Epoch 4 — the e2e suite has three targets, not two.** Production has no machine user
>    and cannot have one; that *is* A7. The authenticated specs skip there and production
>    asserts the 401 instead — which also means `deploy.yml`'s post-deploy run no longer
>    exercises the production SSE stream. Skips must be at `test.describe` scope: Playwright
>    builds a test's fixtures before running its body.
> 21. **Epoch 4 — the acceptance test's `xargs -I{}` form cannot work.** `xargs -I` caps a
>    replacement line at 255 bytes and a Cognito ID token is ~1050. Use `$(…)`.
> 22. **[Epoch 5] A3 was missed by 3x, so `defineSiteStacks()` exists.** The hand-written
>    `infra/bin/app.ts` measured **178** non-blank, non-import, non-comment lines against a
>    target of 60; it is now **45**. The epoch text prescribed exactly this remedy. It is a
>    *function, not a construct*, and the only thing in the package that creates a `Stack` —
>    which is why Architecture no longer says flatly that nothing here does. Proven a no-op:
>    three of the four permanent stacks synth **byte-identical**, `CdkCoreSite` differs only in
>    the `AWS::CDK::Metadata` analytics blob, and the PR stack only in a `deployedAt` timestamp
>    that two synths of identical source also differ in.
> 23. **[Epoch 5] `pnpm publish`, never `npm publish` — and `pnpm pack`, never `npm pack`.**
>    Every version in this workspace is a `catalog:` specifier, which npm cannot resolve: an
>    npm-packed tarball ships `"aws-jwt-verify": "catalog:"` and dies in the consumer's install
>    with `EUNSUPPORTEDPROTOCOL`. Caught by `scripts/consumer-smoke.sh --pack` **before** 0.1.0
>    went out, which is the entire reason that script exists — an npm version is permanent.
>    D7 and the Epoch 5 deliverable both said `npm publish`; both now say why they do not.
> 24. **[Epoch 5] `scripts/verify-preview.sh`'s SSE check had been failing since Epoch 4.**
>    Making `/events/*` require a token turned the unauthenticated stream into a 401, and
>    nothing caught it because Epoch 4's handoff ran the script only in `--expect-absent` mode,
>    where a failing request is the expected result. It now takes `--id-token` and, given none,
>    asserts **401** — a better check than the one it replaced, because it proves from outside
>    that the preview API enforces auth.
> 25. **[Epoch 5] The post-teardown failures are KVS propagation, not edge caching.** Epoch 4's
>    handoff blamed already-cached 200s. The residual answer is **403**, on `/api/*` too, which
>    is `CACHING_DISABLED` — so caching cannot explain it. Some edges still resolve a key
>    `list-keys` already reports gone, rewrite to a `/pr-<n>/` prefix whose objects are deleted,
>    and get S3's `AccessDenied`. Measured on `CdkCore-pr-9`: 1/7 checks passing during the
>    delete, 3/7 the moment it finished, 7/7 under a minute later.
> 26. **[Epoch 5] A5 needed two attempts, and the first is a finding about the skill.** The
>    first fresh session made exactly the right change, committed, then stopped to ask whether
>    to push, because pushing deploys to AWS. Correct in general, wrong here, and the `preview`
>    skill was silent on it. It now says opening the PR *is* the task — a preview is
>    self-cleaning and IAM-scoped to `<Prefix>-pr-*` — and lists what does still deserve a
>    question. The second run went straight through with no other change.
> 27. **[Epoch 5] `infra/bin/app.ts` is generated from the `new-site` template**, and
>    `test/workflow-templates.test.ts` asserts the round-trip byte for byte — the drift guard
>    the four workflow templates already had. Editing one without the other goes red.
> 28. **[Epoch 5] The plugin's skills appear one session after `extraKnownMarketplaces` lands.**
>    The first session registers the marketplace; the next exposes the skills. Measured twice.
>    Not a broken manifest, and not worth debugging — start a second session.
>
> 29. **[Epoch 6] A8 needed a deliberately broken account, and the sweeper's code needed no
>    change.** Every earlier live run found an open PR or nothing, so its delete paths had only
>    run against fakes. Three stacks deployed for already-closed PRs, plus a hand-written key
>    and `pr-6/` prefix under a *fourth* closed PR, gave one sweep all three paths at once —
>    the key and prefix have to be orphaned under a different number than any stack, because a
>    stack delete removes its own key and prefix and would have hidden two of the three.
> 30. **[Epoch 6] KVS create-side propagation is ~29 s for a new hostname, not "a few
>    seconds".** Median 29.0 s, range 14.3-29.4 (7 samples, fresh hostname each, one PoP). A
>    hostname the edge already knows re-propagates in ~1.4 s, so the cost is the novelty of the
>    key. `pr-preview.yml`'s 5-minute poll has ~10x headroom, not ~100x. D2 has it.
> 31. **[Epoch 6] KVS delete-side propagation is ~46 ms at the nearest PoP** (median of 7,
>    range 42-47, every sample ending in a real 404). Revision 25's ~1 minute is not wrong:
>    that measured the *last* edge to catch up during a teardown. Different things.
> 32. **[Epoch 6] The router costs no measurable latency.** 40 interleaved pairs, order
>    randomized within each pair: preview median 206.9 ms, prod 210.4 ms, per-pair delta
>    **-5.2 ms**. The KVS read and `updateRequestOrigin()` are under the noise floor. Router
>    `ComputeUtilization` p99 is **26.4-30.0%**, max 30.
> 33. **[Epoch 6] `FunctionComputeUtilization` needs `Region=Global` as well as
>    `FunctionName`.** With `FunctionName` alone `get-metric-statistics` returns an empty
>    datapoint list and no error, which is indistinguishable from "never invoked".
> 34. **[Epoch 6] Cancelling a deploy mid-flight really does leave a working preview**, and a
>    force-deleted branch really does tear down. Both were predicted by D3 and neither had been
>    watched: CloudFormation finished 87 s after the cancelled runner died and the preview
>    served 200; a deleted branch had `pr-teardown.yml` running 4 s later, with no branch to
>    check out — which is exactly why that workflow has no checkout.
> 35. **[Epoch 6] The KVS retry loop was silent, so the race proved less than it looked.** Both
>    concurrent deploys landed their keys and their handler invocations overlapped by ~1.1 s,
>    but CloudWatch held only the runtime's INIT/START/END lines — a survived conflict and a
>    lucky serialization are indistinguishable in that log. `applyKvsRoute` now logs every
>    retry and every success that needed one. **The retry path is still unobserved**: the
>    logging shipped after the race.
> 36. **[Epoch 6] `id-token: write` no longer means "touches AWS".** `publish.yml` requests it
>    for npm's OIDC and touches no AWS at all, so `workflow-templates.test.ts`'s pairing
>    comment and `.claude/rules/workflows.md` both said something false and were corrected in
>    the same commit. The pairing itself still works — it selects OIDC-authenticating
>    workflows, whichever the audience.
> 37. **[Epoch 6] Trusted publishing needs npm >= 11.5.1 even though we publish with pnpm**,
>    because pnpm hands the registry call to the npm CLI and node 22 bundles npm 10.x. npm also
>    matches its trusted-publisher config on the **workflow filename**, so `publish.yml` cannot
>    be renamed without breaking publishing with no error on this side. `--provenance` is
>    undocumented in `pnpm publish --help` but accepted; whether an attestation is produced is
>    unknown until the first CI publish.
> 38. **[Epoch 6] A torn-down PR stack leaves its CloudWatch log groups behind.** 55
>    `/aws/lambda/CdkCore-pr-*` groups survive, all with no retention, because Lambda creates
>    them and CloudFormation therefore does not own or delete them. `storedBytes` reads 0 for
>    all of them and that field lags, so read it as negligible rather than zero. Nothing in
>    A2's teardown claim costs money today, but the leak is unbounded and the sweeper does not
>    know about log groups. The fix — an explicit `logGroup` with `RemovalPolicy.DESTROY` —
>    cannot be deployed over the existing groups, so it needs them deleted first, which is why
>    teaching the sweeper to reclaim them is likely the better order. **Issue #12** carries the
>    measurement (65 groups, ~5 per PR stack, 23 of them from the *consumer's* functions rather
>    than the package's), both candidate fixes and an acceptance check.
> 39. **[Epoch 6] `pnpm --filter infra exec cdk-core sweep` prints a bare `undefined`** after
>    the table whenever the sweep exits non-zero. It is pnpm's error reporting, not the
>    sweeper: the same run as `node packages/cdk-core/dist/bin/sweep.js` is clean. Nobody had
>    seen it because every previous live run printed `(nothing to reconcile)` and exited 0.
>
> 40. **[Epoch 6] The npm registry lags a successful publish by minutes, and the gap is
>    indistinguishable from a failed one.** `publish.yml` printed `✅ Published
>    @tylerschloesser/cdk-core@0.1.1` at 03:56:45; the registry's own `time` entry says
>    03:59:22, and the raw packument still 404'd for several minutes after that — checked
>    against `registry.npmjs.org` directly, so not the npm CLI's cache. A 404 taken minutes
>    after a green run is not evidence the publish failed. (npm **staged publishing** would
>    produce a permanent version of this symptom — a stage-only trusted publisher holds a
>    version hidden until `npm stage approve`, which needs proof of presence and so can never
>    be completed by a workflow — but that is not what happened here.)
> 41. **[Epoch 6] `--provenance` works through `pnpm publish`** even though `pnpm publish --help`
>    does not list it: 0.1.1's packument carries an attestation with `predicateType:
>    https://slsa.dev/provenance/v1`. The published manifest also carries
>    `{"aws-jwt-verify":"^5.2.1"}`, confirming the `catalog:` specifier resolved through CI.
> 42. **[Epoch 6] `npm install -g npm@latest` now means npm 12**, whose engine range is
>    `^22.22.2 || ^24.15.0 || >=26.0.0`. It works on `setup-node`'s current 22.x and would break
>    under a pinned older node. `npm stage` also exists only from npm 12, so a local npm 11
>    answers `Unknown command: "stage"`.
>
> **Human actions owed: none.** The npmjs.com trusted publisher is configured (organization
> `tylerschloesser`, repository `cdk-core`, workflow filename **`publish.yml`** — npm matches on
> the filename, so renaming that workflow breaks publishing silently) and has published a real
> version through it. Epoch 5's actions are done too: the npm **organization** `tylerschloesser`
> exists (the npm username is `tyle`), and 0.1.0 is published. The user's npm 2FA is a
> **passkey**, which is the whole reason trusted publishing was worth building — and it is now
> out of the release path entirely.
>
> **One thing for the user to confirm (outstanding since Epoch 1):** the repo is public per
> Epoch 1's plan text, and `plan.md`, `progress.md`, `README.md`, `CLAUDE.md`, `.claude/rules/`,
> `docs/spikes/`, `infra/bin/app.ts` and `infra/cdk.context.json` carry the AWS account id, both
> hosted-zone ids, the preview distribution/bucket/KVS ids, the deploy role ARN, GitHub's
> numeric owner/repo ids and both Cognito pool ids with their app client ids. None of it is a
> credential — pool and client ids appear in every authorize URL — but it is world-readable.
> **Neither Epoch 5 nor Epoch 6 added any of it.** Still worth an answer before more
> account detail is committed.

## How to use this document

- **A fresh session executes exactly one epoch.** Start it with `/epoch <n>`; that skill loads
  the Status block, `progress.md`, and the epoch's section. End it with `/handoff`, which
  writes `progress.md`, corrects this file in place, and commits. See
  [Session mechanism](#session-mechanism).
- **Decisions are settled.** The [Decisions log](#decisions-log) records each with its
  reasoning and the source that was checked. A session that disagrees implements as written
  and records the disagreement in its handoff; the user re-decides, not the session.
- **Everything derives from the [Construct API](#construct-api).** Review that first. If it
  is wrong, nothing downstream is worth building.
- Sections: [Context](#context) · [Decisions log](#decisions-log) ·
  [Architecture](#architecture) · [Construct API](#construct-api) · [Epochs](#epochs) ·
  [Acceptance criteria](#acceptance-criteria) · [Cost guardrails](#cost-guardrails) ·
  [Delegation plan](#delegation-plan) · [Session mechanism](#session-mechanism) ·
  [Risks and open questions](#risks-and-open-questions).

## Context

The user is a solo developer with several personal web apps (`thai.ler.dev`,
`yahn.ty.ler.dev`, more to come), one AWS account, a personal GitHub, and heavy Claude
assistance. Every site has the same shape: a Vite single-page app, one or more Hono-on-Lambda
backends mounted by path, SSE streaming, and per-PR preview environments. Two sites already
implement previews and have diverged; `docs/prior-art.md` compares them and is the basis for
what is carried forward. The prompt that produced this plan is `prompt.md`.

This repo (`/Users/tyler/repos/cdk-core`, GitHub `tylerschloesser/cdk-core` — not yet created)
becomes a pnpm monorepo that publishes:

1. **`@tylerschloesser/cdk-core`** on public npm: CDK constructs (`Site`, `PreviewSite`,
   `PreviewDeployment`, `GithubDeployRole`, `siteCertificate`), a tiny runtime `auth` helper
   for browser and server, a `cdk-core sweep` CLI for the orphan sweeper, and the bundled
   Lambda handlers the constructs need.
2. **A Claude Code plugin marketplace** at the repo root (`.claude-plugin/marketplace.json`)
   with one plugin, `cdk-core`, whose skills teach a consumer repo's Claude how previews,
   preview auth, and onboarding work.
3. **A reference site**, `cdk-core.ty.ler.dev`, that consumes the package from the workspace,
   dogfoods PR previews on this very repo, and carries the e2e suite that proves SSE and auth.

### Verified environment (2026-09-06)

| Fact | Value |
| --- | --- |
| AWS account / profile | `063257577013`, `admin` (SSO, **no default region** — pass `--region us-east-1`) |
| CDK bootstrap | v30, qualifier `hnb659fds` |
| Hosted zone `ty.ler.dev` | `Z038502736IM0QLQT7VFN` (records today: apex A, `yahn.ty.ler.dev` A/AAAA, ACM validation CNAMEs) |
| Hosted zone `ler.dev` | `Z0635906RMEZ6PGB3D6I` (thai.ler.dev lives here) |
| `cdk-core.ty.ler.dev` | free: no record, no cert, no distribution |
| GitHub OIDC provider | exists account-wide (`arn:aws:iam::063257577013:oidc-provider/token.actions.githubusercontent.com`); **import, never create** |
| CloudFront distributions | 6 in use of 200; **0 KeyValueStores**; **0 Cognito pools** |
| Other production in this account | `ThaiLerDevSiteStack`, `YahnAppStack-prod`, `HaitianReliefServices`, `OrgHaitianRelief{Prod,Staging}`, `LerDev-Certificate` — never touch |
| Tooling | node 22.18, pnpm 11.25, aws-cdk CLI 2.1140, aws-cdk-lib 2.268 (latest), gh 2.100 (logged in as `tylerschloesser`, token lacks `read:packages`), claude 2.1.263 |
| npm | not logged in; `cdk-core` unscoped was unpublished in 2021 (avoid); `@tylerschloesser/cdk-core` free |
| Prior-art timings | yahn full-clone preview: ~6 min create (CloudFront ~4), ~4 min destroy; thai frontend preview 4m44s |

## Decisions log

Each entry: the decision, why, and what was checked. Sources are in
`docs/research/` (copied from the planning session's research) and `docs/prior-art.md`.

### D1. CloudFront Functions can select the origin; Lambda@Edge is not needed

**Decision.** Route previews with a viewer-request **CloudFront Function** (JS runtime 2.0)
that reads the KeyValueStore and calls `cf.updateRequestOrigin()`. No Lambda@Edge anywhere.

**Why.** Verified against the current CloudFront Developer Guide (`helper-functions-origin-
modification.html`, fetched 2026-09-06): origin modification in CloudFront Functions launched
2024-11-21; `updateRequestOrigin()` works on the viewer-request event only; "the origin set
by the `updateRequestOrigin()` method can be any HTTP endpoint and doesn't need to be an
existing origin within your CloudFront distribution"; settable fields include `domainName`,
`originPath`, `customHeaders`, `customOriginConfig`, `timeouts.readTimeout` (1–120 s), and
`originAccessControlConfig` with `originType` in `s3 | lambda | mediastore | mediapackagev2`.
SST's production `Router` component uses exactly this call (source read from `sst/sst`
`platform/src/components/aws/router.ts`). Cost: $0.10/M invocations + $0.03/M KVS reads,
2M/month of each free; Lambda@Edge would be $0.60/M plus duration and only on cache misses.
Constraints that shape the design: a function runs on every request; it cannot change which
**cache behavior** was selected (behavior is chosen from the original URI before the function
runs), so backend path patterns are fixed per distribution; it cannot read the body; there is
no absolute time limit published, only a `ComputeUtilization` 0–100 metric; `Promise.all`
over KVS reads is discouraged (memory) — use sequential `await`.

**[revised, Epoch 2] Resolved — it signs, and the fallback is dead.** The open sub-question
was whether an inline `{enabled, signingBehavior: always, signingProtocol: sigv4, originType:
lambda}` against a function URL that is *not* a configured origin actually signs. It does.
Proven by hand against a throwaway distribution before any construct was written
(`docs/spikes/2026-09-06-oac-routing-spike.md`): 5 SSE events streamed through at
0/438/939/1440/1941 ms from an `AWS_IAM` `RESPONSE_STREAM` URL CloudFront had never been told
about, and a POST body returned 200 with `x-amz-content-sha256` and 403 without it. The
`authType: NONE` + secret-header fallback is **not** needed and is not implemented.

Two constraints the spike added, both of which cost a debugging cycle and are now in
`.claude/rules/cdk.md`:

- **`await` may not appear inside a call's argument list.** `JSON.parse(await kvs.get(k))` —
  the natural way to write it — fails to publish with `SyntaxError: await in arguments not
  supported`. It is a *syntax* error, so the function never runs and every request through the
  distribution returns `503 The CloudFront function ... is invalid or could not run` with no
  detail at the edge. `aws cloudfront test-function` is the only thing that prints the real
  message. Bind the awaited value to a variable first.
- **Both `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction` must be granted.** Measured in
  both directions with the baseline re-confirmed afterwards: either alone is a **403**, both is
  a 200. There is no signal on the Lambda side — it is never invoked.

### D2. KeyValueStore limits do not bound open PRs; ETag concurrency is store-wide

**Decision.** One KVS per site, one key per preview hostname, JSON value under 1 KB. Writes go
through a CDK custom resource with describe→write→retry-on-conflict.

**Why.** Quotas (`cloudfront-limits.html`): key ≤ 512 B, value ≤ 1 KB, store ≤ 5 MB, ≤ 50
keys or 3 MB per `UpdateKeys`, 1 KVS per function, 200 stores per account. No published
max-keys; at ~250 B per entry the 5 MB store holds ~20k previews. `PutKey`/`UpdateKeys`/
`DeleteKey` **require `If-Match: <ETag>`** from `DescribeKeyValueStore`; the ETag versions the
**whole store**, so two PR deploys racing on different keys still conflict. Documented errors
include `ConflictException` (409) and `ValidationException` (400); the exact code for an ETag
mismatch was not stated. **[revised, Epoch 2] Measured: a stale ETag returns
`ValidationException: Pre-Condition failed during update of Key-Value-Store`**, matching what
SST retries on. The writer still retries on both, because the mapping is undocumented and AWS
is free to change it. **Also measured: deleting a key that does not exist succeeds** (same ETag
back, `ItemCount` unchanged), so the Delete path needs no pre-check and a stack delete cannot
wedge on a key the sweeper already removed. No write rate limit is published;
API calls cost $1 per 1,000. `ListKeys` exists (page ≤ 50, returns values). Propagation to
the edge is "a few seconds" (2023 launch blog; no SLA) — the deploy workflow polls the preview
URL before running e2e. **[revised, Epoch 6] Measured, and "a few seconds" is optimistic for a
*new* hostname: median 29.0 s, range 14.3-29.4 s** (7 samples, a fresh hostname each, put to
first 200 at one PoP). A hostname that PoP has already seen re-propagates in ~1.4 s, so the
cost tracks the novelty of the key rather than the write. The delete side at the same PoP is
~46 ms (median of 7, range 42-47, every sample ending in a real 404) — which does not
contradict revision 25's ~1 minute: that is the *last* edge to catch up, this is the nearest
one. `pr-preview.yml`'s 5-minute poll therefore has ~10x headroom, not the ~100x a single fast
sample would suggest. Calling the KVS API needs SigV4A; Lambda execution-role credentials
are fine, but a CI runner using the *global* STS endpoint gets a v1 token that fails — the
custom resource runs in Lambda precisely to avoid this. **[revised, Epoch 2] SigV4A bites a
second, sharper way: the AWS SDK ships no SigV4A implementation.** It looks one up in a
registry that `@aws-sdk/signature-v4a` populates on import, and in a bundled handler that
lookup finds nothing — every call dies at `describe` with `Neither CRT nor JS SigV4a
implementation is available`, which is exactly how the first PR-stack deploy failed.
`src/handlers/preview-resources.ts` carries a side-effect import of that package, documented at
the import site as load-bearing so nobody removes it as unused.

### D3. Registration: a CDK custom resource in the PR stack, plus a daily sweeper

**Decision.** `PreviewDeployment` (in the PR stack) owns a Lambda-backed custom resource that
writes the KVS key on Create/Update and deletes it on Delete. No registration API. The GitHub
Action does nothing to KVS. A daily `cleanup.yml` runs `cdk-core sweep`, which reconciles
three things against GitHub PR state: CloudFormation stacks with the PR prefix, KVS keys, and
S3 prefixes in the preview bucket.

**Why, versus the alternatives the prompt asked to compare.**
- *Registration API* (a Lambda the PR stack calls): decoupled and cross-account capable, but a
  second service to build, secure, version and monitor, and its teardown still depends on
  someone calling it. Single account makes its main advantage moot. Rejected.
- *Custom resource*: no new service; the KVS ARN and preview-distribution ARN are read from
  SSM parameters the `PreviewSite` publishes; teardown is free with stack delete; IAM is one
  `kvs:*` grant on one ARN. The resource's handler ships inside the npm package (bundled with
  `@aws-sdk/client-cloudfront-keyvaluestore` + `signature-v4-multi-region`, not marked
  external). This is what SST does. **Chosen.**
- *GitHub Action step after `cdk deploy`*: simplest to write, but truth splits between CDK and
  CI, and a cancelled workflow or force-deleted branch leaves the key behind with nothing to
  notice. Rejected for writes; CI keeps the sweeper, where "is the PR closed?" is a GitHub
  question anyway.

**Failure cases the design must survive.** **[revised, Epoch 6] Three of these four have now
been run rather than reasoned about**; each is annotated below.
- *Two PR deploys land at once*: both custom resources describe the store, one `UpdateKeys`
  wins, the other gets 409/400, re-describes, retries with 100–500 ms jitter, up to 10 times.
  **[Epoch 6] Both keys land** — two stacks deployed concurrently (96 s / 97 s, identical
  start) and the two handler invocations overlapped by ~1.1 s. Whether either actually
  *retried* is still unknown: the loop logged nothing. It does now, so the next concurrent
  pair will say.
- *Cancelled workflow*: CloudFormation keeps going (`cancel-in-progress: false`, same
  concurrency group for deploy and teardown), so the stack ends `*_COMPLETE` or `ROLLBACK_*`;
  on rollback the custom resource's Delete runs and removes the key. The sweeper covers the
  rest. **[Epoch 6] Measured**: a run cancelled with the stack in `CREATE_IN_PROGRESS` was
  reported cancelled 23 s later, and CloudFormation reached `CREATE_COMPLETE` **87 s after the
  runner died**, leaving a preview that served 200. The next sweep kept it ("PR is open") and
  exited 0.
- *Force-deleted branch / PR closed while a deploy is in flight*: teardown waits in the same
  concurrency group, then `delete-stack`. If the workflow never ran (GitHub outage, disabled
  Actions), the daily sweeper finds a stack whose PR is closed and deletes it. **[Epoch 6]
  Measured**: deleting the branch closed the PR, `pr-teardown.yml` fired **4 s** later and the
  stack was gone in ~2.5 min — and it ran despite its own branch no longer existing, which is
  the payoff of that workflow having no checkout step.
- *Stack `DELETE_FAILED`* (e.g. the custom resource Lambda was already gone): the sweeper
  retries `delete-stack`; if the key is still present with no stack, the sweeper deletes the
  key and the `pr-<n>/` prefix directly. The sweeper exits non-zero if anything remains.
- *Sweeper safety*: prefix + anchored `^[0-9]+$` on the stack name, `gh pr view` must return
  `CLOSED` or `MERGED` (a lookup failure means "leave it"), and the deploy role's
  `cloudformation:DeleteStack` is IAM-scoped to `stack/<prefix>-pr-*`. `--dry-run` prints
  without deleting and is what the acceptance test uses.

### D4. Cognito: one prod pool and one preview pool per site, one Google client for all sites

**Decision.** `Site` creates a **prod user pool** (Essentials tier, Google as the only IdP, one
app client with authorization-code + PKCE, `ExplicitAuthFlows` = `ALLOW_REFRESH_TOKEN_AUTH`
only, callback `https://<site>/auth/callback`). **[revised, Epoch 4] That list has to be set on
the L1.** CDK's `configureAuthFlows` returns `undefined` for an *empty* `authFlows` as well as
an absent one, so `authFlows: {}` omits `ExplicitAuthFlows` entirely — and an omitted list makes
Cognito apply legacy defaults that include `ALLOW_USER_SRP_AUTH`, i.e. exactly the opposite of
what this decision asks for, silently. `PreviewSite` creates a **separate preview
user pool** for the site (Google IdP, one browser app client whose single callback is the
bounce host, plus one `machine` app client with `ALLOW_USER_PASSWORD_AUTH`, plus one native
user `claude` whose password lives in Secrets Manager). Both pools use the free Cognito
**prefix domain** (`<slug>.auth.us-east-1.amazoncognito.com`), not a custom domain. All sites
share **one Google OAuth client** whose redirect URIs are the pool domains' `/oauth2/idpresponse`.

**Why.**
- *Cost*: the Cognito free tier is 10,000 MAU **per account** (Lite and Essentials), not per
  pool; a pool costs nothing to exist; prefix domains are free. Per-site pools are cost-neutral.
- *Why a separate preview pool rather than app clients in one pool*: the prompt's "overlap"
  question has two halves. A shared **directory** is fine and even desirable (same Google
  users). **Token audience** is the isolation that matters, and within one pool it is only a
  convention: tokens from any app client share `iss` and signing keys, so only the verifier's
  `aud`/`client_id` check separates them; forgetting it in one preview API would accept prod
  tokens. A separate pool makes the prod verifier's `iss` check reject every preview token
  structurally, and it is the only way to make the machine user *not exist* in prod.
- *Why not per-PR app clients*: they need `UpdateUserPoolClient` from CI (read-modify-write of
  the whole client, `ConcurrentModificationException` under races) and are capped at 100
  callbacks; the bounce (D5) needs none of that.
- *Why not groups / custom claims to namespace PR users*: `cognito:groups` and pre-token
  claims can tag a token but cannot stop the prod API from accepting it; they answer the
  directory question, not the audience one.
- *Why prefix domains*: **custom domains are capped at 4 per Region, non-adjustable**, and
  each needs an A record on the parent, a us-east-1 cert, and up to an hour to propagate.
  With `identity_provider=Google` on the authorize URL the user never sees the Cognito page,
  so the domain is cosmetic. `Site` exposes `auth.customDomain` as an escape hatch for up to
  four sites that want `auth.<site>`.
- *Why one Google client*: there is **no API** to create Google OAuth clients (only IAP-locked
  ones); each is manual console work, and Google counts unique second-level domains per
  project (≤ 10) — all `amazoncognito.com` redirect URIs collapse to one. Onboarding a site is
  then "add two redirect URIs to the existing client" (one minute) instead of a new project +
  consent screen + client. The consent screen shows one app name for all sites; acceptable for
  personal use. The client id/secret live once in Secrets Manager
  (`cdk-core/google-oauth`, JSON `{clientId, clientSecret}`); `auth.googleSecretName` lets a
  site bring its own. Consent screen stays in **Testing** (≤ 100 test users): with only
  `openid email profile` the 7-day refresh expiry does not apply.
- *Tier*: Essentials (the default since 2024-11-22). Classic hosted UI, not managed login v2,
  because nothing is branded and the L2 support is simpler. Doc conflict noted: one AWS page
  says social IdPs need managed login; the feature table says Lite+classic works. Essentials
  sidesteps it. **[revised, Epoch 4] Confirmed live**: the classic hosted UI with
  `identity_provider=Google` on an Essentials pool signs a real user in on both pools.
- **[revised, Epoch 4] The shared Google client means the second site's login is silent.** The
  two pools are separate and their tokens live in separate origins' `localStorage`, but Google's
  session and consent grant are per *Google client*, so after signing into production the
  preview's `identity_provider=Google` round trip returns a code with no consent screen.
  Observed, and the visible upside of one-client-for-all-sites.
- **[revised, Epoch 4] A preview API trusts two app clients, not one.** `aud` is the app client
  that minted a token: the machine user's carry `machine`, a human's carry `browser`. A verifier
  given one 401s every call made with the other — measured. `AUTH_CLIENT_ID` is therefore a
  comma-separated allowlist. This does not weaken the isolation the decision is about, which is
  the *pool* and is enforced by `iss`.

### D5. Shared callback: a fixed bounce host, `state` carries only the PR number

**Decision.** Preview browser logins use `redirect_uri = https://oauth.preview.<site>/` on
the preview pool's browser client. The **router CloudFront Function** handles that host: it
parses `state`, which the app formats as `<nonce>.<pr-number>` (nonce = 128-bit base64url,
PR = digits only), rebuilds `pr-<n>.preview.<site>`, checks the key **exists in KVS**, and
302-redirects to `https://pr-<n>.preview.<site>/auth/callback?code=…&state=…`. The PR app
verifies the nonce against `sessionStorage`, then exchanges the code with its PKCE verifier
at the preview pool's `/oauth2/token` using the same `redirect_uri`. Prod uses
`https://<site>/auth/callback` directly with `state = <nonce>`.

**Why.** Cognito callbacks are exact-match, no wildcards (`CreateUserPoolClient` docs); Google
only ever sees the pool domain, so Google is not the constraint the prompt assumed — Cognito's
callback list is. RFC 9700 §4.11.1 (BCP 240, Jan 2025): "Clients MUST NOT expose open
redirectors … clients should only redirect if the target URLs are allowed". Carrying **no
URL** in `state` — only digits that are formatted into a fixed template — makes the redirect
allowlisted by construction; the KVS existence check additionally refuses PRs that were never
deployed. PKCE (S256, the only method Cognito accepts) binds the code to the browser that
started the flow, so the code crossing one extra redirect is not exfiltrable. `state` must
not be URL-encoded JSON (Cognito rule) — the dotted form avoids that. The bounce runs entirely
in the CloudFront Function: no origin, no page, no server state.

### D6. Machine auth: a preview-only native user, tokens seeded into `localStorage`

**Decision.** `PreviewSite` creates, in the **preview pool only**: app client `machine`
(`ALLOW_USER_PASSWORD_AUTH`, no hosted UI), native user `claude` (`AdminCreateUser` with
`MessageAction: SUPPRESS`, `AdminSetUserPassword --permanent`), and a Secrets Manager secret
`<site>/preview-machine-user` `{username, password, clientId, userPoolId}`. Claude obtains
tokens with `cognito-idp initiate-auth --auth-flow USER_PASSWORD_AUTH`, then either calls
APIs with `x-id-token: <IdToken>` or seeds a browser: the app's own storage key
`cdkcore:auth` (JSON `{idToken, accessToken, refreshToken, expiresAt}`) set via Playwright
`addInitScript` before the first navigation.

**Why.**
- *Structurally impossible in prod*: the prod pool has no native users, its only client has
  no password flow (`ExplicitAuthFlows` set explicitly — the default would allow SRP), and the
  prod API verifies `iss` = prod pool. There is no flag to flip. **[revised, Epoch 4] Verified
  from the outside**, not just intended: `describe-user-pool-client` returns
  `["ALLOW_REFRESH_TOKEN_AUTH"]`, `list-users` returns `[]`, and a preview ID token gets 401
  from `https://cdk-core.ty.ler.dev/api/me`. The corollary is that the **e2e suite has three
  targets**: production has no machine identity and cannot have one, so the authenticated specs
  skip there and it asserts the 401 instead. Note the doc finding that
  removing `COGNITO` from `SupportedIdentityProviders` is cosmetic; it is `ExplicitAuthFlows`
  that gates SDK sign-in, so that is what is pinned.
- *Why not client-credentials*: no user, no ID token, custom scopes only, billed per token
  with no free tier, cannot drive a browser session. Right for service-to-service, wrong for
  "drive the UI as a user".
- *Why not a signed bypass*: it would be a second auth path in the API that has to be kept out
  of prod by discipline.
- *Why `localStorage` + header rather than a cookie session*: the API stays stateless (JWT
  verified with `aws-jwt-verify`), the SSE reader is `fetch`-based (as in yahn) so it can send
  the header, and nothing in the shared layer has to own sessions or storage. The key is our
  own, not Amplify's internals, so it is stable. CloudFront strips `Authorization` on GET and
  OAC overwrites it anyway, hence `x-id-token`.
- *Scopes gotcha*: `InitiateAuth` access tokens carry only `aws.cognito.signin.user.admin`;
  the API authorizes on the **ID token** (`sub`, `email`, `cognito:groups`), never on scopes.

### D7. Package registry: public npm, scoped

**Decision.** Publish `@tylerschloesser/cdk-core` to npmjs.org with `--access public`. Manual
`pnpm publish` from a tagged commit in Epoch 5 (**[revised, Epoch 5]** `npm publish` cannot
work — it leaves `catalog:` specifiers unresolved in `dependencies`); GitHub Actions trusted publishing is a later
option. **[revised, Epoch 6] That later option is built**: `.github/workflows/publish.yml`
publishes by OIDC on a `v*` tag, with no token anywhere. It still runs `pnpm publish`, because
the `catalog:` problem is unchanged, and it upgrades npm first — pnpm hands the registry call
to the npm CLI and trusted publishing needs npm >= 11.5.1, which node 22 does not bundle. npm
matches the trusted-publisher config on the **workflow filename**, so `publish.yml` cannot be
renamed without breaking publishing silently.

**Why.** GitHub Packages needs a token with `read:packages` in every consumer's `.npmrc` and
every CI job (the user's `gh` token lacks even that scope today), for no benefit on a public
personal package. Public npm needs one `npm login` once. The unscoped name `cdk-core` was
unpublished in 2021 and may be blocked; the scope is free and unambiguous.

### D8. Session strategy: files + two skills, no harness

**Decision.** `plan.md` (this file, corrected in place), `progress.md` (append-only log),
`/epoch <n>` and `/handoff` skills in `.claude/skills/`, sonnet `implementer`/`verifier`
agents, `CLAUDE.md` + `.claude/rules/`. No hooks, no custom loop. Details in
[Session mechanism](#session-mechanism). **[revised, Epoch 6] The two skills now also ship as a
second plugin, `epochs`, in this repo's marketplace**, which is what the Epoch 6 line
recommended. This repo still runs its own `.claude/skills/` copies: those carry its AWS
specifics, and a plugin asserting them would state something false about a consumer's repo.
Four rules are generalized in the plugin copy and nothing else.

**Why.** Every primitive needed exists today (verified against code.claude.com docs
2026-09-06): skills with `disable-model-invocation`, `argument-hint`, `$0`, and `` !`cmd` ``
injection; project agents with `model: sonnet`; `SessionStart`/`Stop` hooks; `claude -p`.
The user already runs this shape by hand (a plan with a Status block and `[revised]`
markers, per-epoch kickoff prompts in `~/.claude/plans/`); the skills make the kickoff and
the handoff *generated from the plan* instead of hand-written, and keep everything in the
repo. A `Stop` hook that blocks stopping until a handoff exists was considered and rejected
for now: it fires on every turn, including a question mid-epoch, and the `/epoch` skill's
last rule plus the acceptance check in `/handoff` cover the same ground without friction.
The only thing built-ins cannot do is start the next session by themselves; a shell loop
over `claude -p "/epoch n"` is the answer if that is ever wanted, and is left as an optional
script because whether `-p` accepts a skill as its prompt is not documented.

### D9. Hostname and certificate scheme

**Decision.** Prod at `<site>` (e.g. `cdk-core.ty.ler.dev`). Previews at
**`pr-<n>.preview.<site>`**, with the bounce host `oauth.preview.<site>`. One ACM certificate
in us-east-1 with SANs `[<site>, *.preview.<site>]`, DNS-validated in the site's hosted zone.
One wildcard alias record `*.preview.<site>` (A + AAAA) pointing at the preview distribution;
the apex A/AAAA points at the prod distribution. Cognito uses prefix domains, so no
`auth.<site>` record is needed (escape hatch adds `auth.<site>` as a third SAN).

**Why.** A wildcard covers exactly one label, so `*.<site>` would not cover
`pr-1.preview.<site>`, and `*.preview.<site>` is what the wildcard DNS record and the
distribution's alternate-domain-name both match. Keeping previews one label below `preview`
also keeps the preview wildcard from overlapping any other host on `<site>` (a wildcard alias
would otherwise shadow, and CloudFront's cross-account alias rules would bite, the Cognito
custom-domain distribution if it were ever added). Wildcard DNS removes the per-PR record and
yahn's NXDOMAIN gate. The existing sites use `pr-<n>.<site>`; migration would move them one
label, which is acceptable and out of scope.

### D10. Assets are keyed by URI prefix, not by Host

**Decision.** The router rewrites `request.uri` to `/pr-<n>/<uri>` (and `/pr-<n>/index.html`
for extensionless paths) against **one shared preview bucket**; it does not use `originPath`
and does not add `Host` to the cache key. Backends are `CACHING_DISABLED`.

**Why.** CloudFront computes the cache key from the viewer request as modified by the
viewer-request function; `originPath` is invisible to the cache key, so two PRs' `/index.html`
would collide. **[revised, Epoch 2] Confirmed by measurement**, not inference: two `pr-<n>/`
prefixes serving the same viewer path `/` returned different bodies, both `x-cache: Hit from
cloudfront`, with query strings excluded from the cache policy so the rewritten URI was the
only differentiator. The per-PR-bucket fallback is not needed. `Host` in a cache policy is forwarded to the origin and breaks S3. A URI rewrite
gives distinct cache keys, works with `distributionPaths: ['/pr-<n>/*']` invalidation, and
lets `PreviewDeployment` be an S3 upload to a prefix (`retainOnDelete: false`,
`prune` within the prefix) rather than a bucket per PR — the cheapest possible deploy and
teardown, with the bucket's OAC policy shared.

### D11. Environment config is a deployed `/__config.json`, not a build-time variable

**Decision.** `Site` and `PreviewDeployment` write `__config.json`
(`{site, mode: 'prod'|'preview'|'local', pr?, auth: {issuer, clientId, domain}}`) into the
asset prefix. The browser helper fetches it. `pnpm dev` serves a local one with
`mode: 'local'`.

**Why.** The web bundle stays identical across prod, every preview, and local, so one build
per CI run serves both the prod deploy and previews, and pool/client ids never have to be
threaded through Vite env vars or CDK context.

## Architecture

### Stacks a consumer repo defines (the reference does exactly this)

| Stack | Deployed by | Holds |
| --- | --- | --- |
| `<Prefix>Shared` | `deploy.yml` and by hand | the one ACM certificate (`siteCertificate`) |
| `<Prefix>Site` | `deploy.yml` on push to `main` | `Site`: prod bucket, distribution, DNS apex, prod user pool, the prod backends' Lambdas (consumer-owned) |
| `<Prefix>Preview` | `deploy.yml` (rarely changes) | `PreviewSite`: preview bucket, KVS, router function, preview distribution, wildcard DNS, preview user pool + machine user, SSM parameters |
| `<Prefix>-pr-<n>` | `pr-preview.yml` per PR; deleted by `pr-teardown.yml`/sweeper | `PreviewDeployment` + the PR's backend Lambdas (consumer-owned); optional data (consumer-owned, `RemovalPolicy.DESTROY`) |
| `<Prefix>GithubOidc` | **by hand, once** | `GithubDeployRole` |

Stack knowledge stays in the consumer's `bin/app.ts`; **the constructs** never create stacks.
**[revised, Epoch 5]** `defineSiteStacks()` does — it is a plain function, not a construct, and
it exists because writing those five stacks out by hand measured 178 non-import lines against
A3's target of 60. It composes the same constructs a consumer could wire themselves and returns
every stack and construct it made, so nothing is hidden behind it.

### Request path for a preview

```
browser ──► pr-12.preview.site (wildcard A → preview distribution)
            │
            ├─ behavior "/api/*"  ──► router fn: kvs.get("pr-12.preview.site") → backends.api
            │                          cf.updateRequestOrigin({domainName: <lambda url host>,
            │                            customOriginConfig: {https}, originAccessControlConfig:
            │                            {enabled, always, sigv4, originType: lambda},
            │                            timeouts: {readTimeout: 60}})  ──► PR 12's Lambda URL
            ├─ behavior "/events/*" ─► same, backends.events (RESPONSE_STREAM URL)
            └─ default (S3) ─────────► router fn: request.uri = "/pr-12" + uri, or "/pr-12/index.html"
                                       for any extensionless path (SPA shell — see below)
                                       origin unchanged: shared preview bucket (OAC)

browser ──► oauth.preview.site/?code=..&state=<nonce>.<12>
            └─ router fn: validate digits, kvs.exists("pr-12.preview.site") → 302 to
               https://pr-12.preview.site/auth/callback?code=..&state=..

unknown host / missing key ──► router fn returns 404 "no such preview"
```

KVS key: the full hostname. Value (≤ 1 KB):

```json
{"v":1,"pr":12,"assets":"/pr-12","backends":{"api":"abc123.lambda-url.us-east-1.on.aws","events":"def456.lambda-url.us-east-1.on.aws"},"deployedAt":"2026-09-07T01:02:03Z"}
```

**[revised, Epoch 2] The SPA fallback serves the shell; it does not append `index.html`.** A
path whose last segment has no extension is a client route, so it rewrites to
`<assets>/index.html`. The first implementation appended, turning `/auth/callback` into
`pr-12/auth/callback/index.html`, and every deep route came back **403** — not 404, because an
OAC bucket policy grants `s3:GetObject` and not `s3:ListBucket`, so S3 answers a missing key
`AccessDenied`. A genuinely missing *asset* still fails, which is the point of keying on the
extension. Epoch 4 would have hit this on its first Google login.

The router function's code is generated by `PreviewSite` from the backend definitions (path
patterns, read timeouts) and the site domain, so it needs no per-request configuration beyond
KVS. It is associated with every behavior. Budget: under 10 KB, sequential `await`s, no
`Promise.all`.

### Prod distribution

Same shape as thai/yahn's `addSite`: S3 + OAC default behavior with the SPA-fallback function,
one `additionalBehavior` per backend with `FunctionUrlOrigin.withOriginAccessControl`,
`ALL_VIEWER_EXCEPT_HOST_HEADER`, the explicit `lambda:InvokeFunction` grant, two
`BucketDeployment`s (hashed assets immutable + prune; HTML/unversioned `no-cache` + invalidation),
apex A/AAAA. Backends default to `CACHING_DISABLED`; a consumer can pass a cache policy
(yahn's origin-decides policy is offered as `CachePolicies.originDecides(scope)`).

### SSE

Proven shape from yahn, adopted verbatim: Hono `streamHandle` → function URL with
`invokeMode: RESPONSE_STREAM` → behavior with `CACHING_DISABLED`, `compress: false`,
`readTimeout: 60 s`; the producer emits a `: keepalive` comment at least every 15 s; the
endpoint is a **GET** (a POST body under OAC needs a client-computed `x-amz-content-sha256`);
the browser reads with `fetch` + a small SSE parser, not `EventSource`, so it can send
`x-id-token`. CloudFront does not buffer chunked responses and does not compress
`text/event-stream` (verified in the docs' compressible-type list). No
`responseCompletionTimeout` is set anywhere. In previews the router sets the same
`readTimeout` via `updateRequestOrigin.timeouts`. The e2e test asserts **inter-event arrival
timing**, not just the final body.

### Auth flow (browser)

1. `auth/browser` fetches `/__config.json`; `mode: 'local'` shows a dev-login box that stores
   `dev:<name>` as the token. Otherwise it builds the Cognito authorize URL with
   `identity_provider=Google`, PKCE S256, `redirect_uri` per D5, `state` per D5, and stores
   `{verifier, nonce}` in `sessionStorage`.
2. Callback route `/auth/callback`: checks nonce, exchanges the code at
   `https://<pool-domain>/oauth2/token`, stores tokens under `localStorage["cdkcore:auth"]`,
   returns to the pre-login path.
3. `apiFetch()` adds `x-id-token`, refreshes with the refresh token when < 5 min remain, and
   computes `x-amz-content-sha256` for any request with a body.
4. `auth/server` exports `createVerifier({ issuer, clientId })` (aws-jwt-verify, ID token,
   single client id) and `getUser(c)` for Hono, plus `AUTH=local` mode that trusts
   `x-id-token` starting with `dev:`. Lambda env never sets `AUTH=local`; the constructs set
   `AUTH=cognito` with the pool's issuer and client id on the backend Lambdas' environment.

### Local dev

`pnpm dev` = Vite (`:5173`, proxies `/api` → `:3001`, `/events` → `:3002`, serves a local
`/__config.json`) + `tsx watch` for each backend on its own port, mirroring the two behaviors.
No credentials, no AWS SDK calls, no network beyond localhost. Target: first byte from Vite
and `/api/ping` answering within 10 s of `pnpm dev`. Playwright with `PLAYWRIGHT_BASE_URL`
unset boots `pnpm dev` itself; set it to a preview URL and the identical specs run there, with
`PREVIEW_MACHINE_SECRET` (or the AWS profile) providing machine-auth tokens.

### The sweeper (`cdk-core sweep`)

```
cdk-core sweep --site cdk-core.ty.ler.dev --stack-prefix CdkCore --repo tylerschloesser/cdk-core [--dry-run]
```

1. `cloudformation list-stacks` (non-deleted statuses) filtered to `^<prefix>-pr-(\d+)$`.
2. For each: `gh pr view <n> --json state`; delete only on `CLOSED`/`MERGED`; on lookup error
   leave it and report; `delete-stack` + wait; continue past failures; red exit at the end.
3. `ListKeys` on the site's KVS (from SSM `/cdk-core/<site>/preview/kvsArn`): any
   `pr-<n>.preview.<site>` whose stack does not exist **and** whose PR is closed → `DeleteKey`
   (with ETag).
4. `ListObjectsV2` with `Delimiter=/` on the preview bucket: any `pr-<n>/` prefix with no stack
   and closed PR → delete objects.
5. Print a table of what was found/deleted/left; `--dry-run` deletes nothing and exits 0 only
   if nothing *would* be deleted.

## Construct API

Draft TypeScript for `@tylerschloesser/cdk-core`. Defaults and escape hatches are in the
comments. This is the review surface; everything else is derived.

```ts
import type * as acm from 'aws-cdk-lib/aws-certificatemanager'
import type * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import type * as cognito from 'aws-cdk-lib/aws-cognito'
import type * as lambda from 'aws-cdk-lib/aws-lambda'
import type * as route53 from 'aws-cdk-lib/aws-route53'
import type * as s3 from 'aws-cdk-lib/aws-s3'
import type { Duration } from 'aws-cdk-lib'
import type { Construct } from 'constructs'

// ---------- shared ----------

/** Where the site lives. Everything is derived from these two values. */
export interface SiteDomain {
  /** e.g. 'cdk-core.ty.ler.dev'. Previews are `pr-<n>.preview.<domain>`. */
  readonly domain: string
  /** The hosted zone that contains `domain`. Imported by the consumer, never created here. */
  readonly zone: route53.IHostedZone
}

/** One ACM certificate covering `domain` and `*.preview.<domain>` (+ `auth.<domain>` if asked). Must be us-east-1. */
export function siteCertificate(scope: Construct, id: string, props: SiteDomain & {
  readonly includeAuthHost?: boolean // default false
}): acm.Certificate

/** A backend mounted by path. The same shape is used by Site and PreviewSite; only Site needs the origin. */
export interface BackendProps {
  /** CloudFront path pattern, e.g. '/api/*'. Must not overlap another backend or '/__config.json'. */
  readonly pathPattern: string
  /** Set when the Lambda URL is RESPONSE_STREAM. Forces compress:false, CACHING_DISABLED, readTimeout default 60s. */
  readonly streaming?: boolean
  /** Origin read timeout. Default 30s, or 60s when streaming. Max 120s without a quota increase. */
  readonly readTimeout?: Duration
  /** Default CachePolicy.CACHING_DISABLED. Ignored in previews (always disabled). */
  readonly cachePolicy?: cloudfront.ICachePolicy
  /** Default ALLOW_ALL. */
  readonly allowedMethods?: cloudfront.AllowedMethods
  /** Escape hatch: merged last into the behavior. Cannot replace `origin` or `functionAssociations`. */
  readonly behaviorOverrides?: Partial<cloudfront.BehaviorOptions>
}

export interface AuthProps {
  /** Secrets Manager secret name holding {clientId, clientSecret} for the Google OAuth client. Default 'cdk-core/google-oauth'. */
  readonly googleSecretName?: string
  /** Cognito domain prefix. Default: domain with dots → dashes (+ '-preview' for the preview pool). */
  readonly domainPrefix?: string
  /** Escape hatch: use `auth.<domain>` as a Cognito custom domain (max 4 per Region!). Needs the cert to include it. Default: prefix domain. */
  readonly customDomainCertificate?: acm.ICertificate
  /** Token lifetimes. Defaults: id/access 1h, refresh 30d. */
  readonly idTokenValidity?: Duration
  readonly refreshTokenValidity?: Duration
  /** Escape hatch applied to the UserPool props. */
  readonly userPoolOverrides?: Partial<cognito.UserPoolProps>
}

/** Env vars the constructs put on a backend Lambda so `auth/server` can verify tokens. */
export interface AuthEnvironment {
  readonly AUTH: 'cognito'
  readonly AUTH_ISSUER: string
  // [revised, Epoch 4] One client id, or a comma-separated list. Prod is one; a preview is two,
  // because `aud` is the app client that minted the token and the machine user signs in through
  // a different client than a human does.
  readonly AUTH_CLIENT_ID: string
}

// ---------- Site (prod) ----------

export interface SiteProps extends SiteDomain {
  readonly certificate: acm.ICertificate
  /** Absolute path to the built SPA (e.g. apps/web/dist). Throws at synth if missing. */
  readonly webDist: string
  /** Backends keyed by a short id ('api', 'events'). Keys must match PreviewSite/PreviewDeployment. */
  readonly backends: Record<string, BackendProps & { readonly functionUrl: lambda.IFunctionUrl }>
  /** Omit for a public site with no user pool. */
  readonly auth?: AuthProps
  /** File globs that must never be cached hard. Default ['*.html', 'sw.js', 'manifest.webmanifest', 'registerSW.js', '__config.json']. */
  readonly unversioned?: string[]
  /** Escape hatch merged into DistributionProps (priceClass, httpVersion, webAclId, logging, ...). Cannot replace behaviors, domainNames or the certificate — [revised, Epoch 3] `safeDistributionOverrides()` strips those four keys, which is what makes this comment true. */
  readonly distributionOverrides?: Partial<cloudfront.DistributionProps>
  /** Extra behaviors the consumer owns entirely (must not collide with backends). */
  readonly additionalBehaviors?: Record<string, cloudfront.BehaviorOptions>
}

export class Site extends Construct {
  readonly distribution: cloudfront.Distribution
  readonly bucket: s3.Bucket
  readonly url: string                              // https://<domain>
  readonly userPool?: cognito.UserPool
  readonly userPoolClient?: cognito.UserPoolClient
  /** Env to spread onto each backend Lambda; empty object when `auth` is omitted. */
  readonly authEnvironment: AuthEnvironment | Record<string, never>
  constructor(scope: Construct, id: string, props: SiteProps)
}

// ---------- PreviewSite (shared, one per site) ----------

export interface PreviewSiteProps extends SiteDomain {
  readonly certificate: acm.ICertificate
  /** Same keys as Site.backends; origins are dynamic so only the routing props are used. */
  readonly backends: Record<string, BackendProps>
  /** Omit for a site with no auth. When present, creates the preview pool, machine client, machine user and secret. */
  readonly auth?: AuthProps
  /** Machine user name. Default 'claude'. Secret: '<domain>/preview-machine-user'. */
  readonly machineUserName?: string
  /** SSM namespace for what PR stacks read. Default '/cdk-core/<domain>/preview'. */
  readonly parameterPrefix?: string
  readonly distributionOverrides?: Partial<cloudfront.DistributionProps>
}

export class PreviewSite extends Construct {
  readonly distribution: cloudfront.Distribution
  readonly bucket: s3.Bucket
  readonly keyValueStore: cloudfront.KeyValueStore
  readonly routerFunction: cloudfront.Function
  readonly userPool?: cognito.UserPool
  readonly machineUserSecret?: secretsmanager.ISecret
  /** Published to SSM under parameterPrefix: distributionArn, distributionId, bucketName, kvsArn, authIssuer, authClientId, authDomain, authMachineClientId, machineSecretArn. [revised, Epoch 4] `authDomain` because the hosted-UI host is not derivable from the issuer, and `authMachineClientId` because the API must accept `aud` from either client. */
  readonly parameterPrefix: string
  constructor(scope: Construct, id: string, props: PreviewSiteProps)
}

// ---------- PreviewDeployment (one per PR, in the PR stack) ----------

export interface PreviewDeploymentProps {
  readonly domain: string
  /** PR number. Validated /^[0-9]+$/ (the stack name is derived from it upstream, not here). */
  readonly pr: number
  readonly webDist: string
  /** Same keys as PreviewSite.backends. Any IFunctionUrl works, including an imported production one. */
  readonly backends: Record<string, lambda.IFunctionUrl>
  /** Default '/cdk-core/<domain>/preview'. */
  readonly parameterPrefix?: string
  readonly unversioned?: string[]
  // [revised, Epoch 4] Set when the site's PreviewSite was created with `auth`. There is
  // nothing to detect: `valueForStringParameter` on a parameter that does not exist fails the
  // *deploy*, not the synth, so a PR stack has to be told — and the consumer already knows.
  readonly auth?: boolean
}

export class PreviewDeployment extends Construct {
  readonly hostname: string   // pr-<n>.preview.<domain>
  readonly url: string        // https://pr-<n>.preview.<domain>
  /** Env to spread onto each PR backend Lambda (AUTH=cognito, preview pool issuer/client) or {} when the site has no auth. */
  readonly authEnvironment: AuthEnvironment | Record<string, never>
  /** Tag every resource + the stack with cdk-core:pr=<n>; the consumer's stack name must be `<prefix>-pr-<n>`. */
  constructor(scope: Construct, id: string, props: PreviewDeploymentProps)
}

// ---------- GithubDeployRole (by hand, once) ----------

export interface GithubDeployRoleProps {
  readonly repo: string             // 'tylerschloesser/cdk-core'
  readonly roleName: string         // 'cdk-core-github-deploy'
  /** Stack-name prefix; DeleteStack is scoped to `<stackPrefix>-pr-*`. */
  readonly stackPrefix: string
  readonly domain: string           // to scope KVS + bucket sweeper permissions via SSM lookups
  /** Default: import the account's existing provider. */
  readonly oidcProviderArn?: string
  // [revised, Epoch 3] GitHub's numeric ids. With both, the immutable
  // `repo:<owner>@<ownerId>/<name>@<repoId>:…` subject is trusted alongside the legacy
  // `repo:<owner>/<name>:…` one. `repo` alone cannot build it, and the only alternative —
  // a wildcard on the owner id — would trust whoever later takes the owner name, which is
  // the exact thing the immutable form exists to prevent.
  readonly ownerId?: string
  readonly repoId?: string
}
export class GithubDeployRole extends Construct { readonly role: iam.Role }

// ---------- defineSiteStacks (the four-stack layout in one call) ----------
//
// [Epoch 5] Added because the hand-written form of the five stacks measured 178
// non-import lines against A3's target of 60; the epoch's own instruction for that
// case is to add the convenience and re-count, keeping the constructs primary.
// After it, `infra/bin/app.ts` is 45. It is a **function, not a construct**, and it
// is the only thing in the package that creates a `Stack`.

export interface DefineSiteStacksProps {
  readonly env: Environment
  readonly stackPrefix: string            // 'CdkCore' -> CdkCore{Shared,Preview,Site,GithubOidc}, CdkCore-pr-<n>
  readonly domain: string
  readonly zone: route53.HostedZoneAttributes   // imported by attributes, never created
  readonly webDist: string
  /** Routing only; the same map feeds both distributions so they cannot disagree. */
  readonly backends: Record<string, BackendProps>
  /** Called once per stack that needs live Lambdas (prod, and each PR stack). Keys must match `backends`.
   *  The function URL is added here, from that key's `streaming` flag: AWS_IAM always, RESPONSE_STREAM when streaming. */
  readonly functions: (scope: Construct) => Record<string, lambda.Function>
  /** `preview` is merged over the shared props for the preview pool only. */
  readonly auth?: AuthProps & { readonly preview?: AuthProps }
  /** Omit to skip the OIDC stack entirely. */
  readonly github?: { repo: string; roleName: string; ownerId?: string; repoId?: string; oidcProviderArn?: string }
  readonly stackProps?: Omit<StackProps, 'env'>
  readonly siteOverrides?: Partial<{ unversioned: string[]; distributionOverrides: ...; additionalBehaviors: ... }>
  readonly previewOverrides?: Partial<{ machineUserName: string; parameterPrefix: string; distributionOverrides: ... }>
}

/** Returns every stack and construct it made; `pr`/`previewDeployment` only under `-c pr=<n>`. */
export function defineSiteStacks(app: App, props: DefineSiteStacksProps): SiteStacks

// ---------- runtime subpaths ----------
// '@tylerschloesser/cdk-core/auth/browser': loadConfig(), login(devUser?), handleCallback(), getToken(), logout(), apiFetch(), readSse()
// '@tylerschloesser/cdk-core/auth/server':  createVerifier(env), getUser(c), authMode(), isLocalMode()
// bin: 'cdk-core sweep ...'
//
// [revised, Epoch 1] `aws-cdk-lib` and `constructs` are **optional** peer dependencies, and
// `auth/server` types Hono's context structurally (`RequestLike`: `{ req: { header(name) } }`)
// rather than importing `hono`. A browser bundle or a Lambda that only wants the auth helpers
// must not be made to install CDK, and the package must not pin a consumer's Hono major.
```

Notes on the abstraction:

- **[revised, Epoch 3] What `Site` and `PreviewSite` share is code, not convention.** The
  package also exports `backendBehavior()` and `safeDistributionOverrides()` (`src/behaviors.ts`),
  `backendReadTimeoutSeconds()` (`src/backend.ts`) and `renderSpaSource()` (`src/router/spa.ts`).
  They are exported rather than internal so a consumer building a third distribution shape gets
  the same `ALL_VIEWER_EXCEPT_HOST_HEADER` + `compress: false` + unoverridable-origin behavior
  the two constructs use. The refactor was proven to be a no-op: `cdk synth CdkCorePreview` is
  byte-identical before and after it.
- **[revised, Epoch 3] `Site`'s bucket is `RemovalPolicy.DESTROY` with `autoDeleteObjects`.**
  It holds only build output, every byte reproducible from a deploy, and the epoch's Teardown
  promises `cdk destroy CdkCoreSite` removes everything. A consumer whose bucket holds anything
  else should pass their own via an escape hatch rather than inherit this.
- **[revised, Epoch 2] Two small additions the implementation needed.** `PreviewSite` also
  exports `previewParameterPrefix(domain)` so `PreviewDeployment` and a consumer's sweeper
  derive the SSM namespace from one place instead of three string literals, and
  `renderRouterSource(props)` is exported from `.` so the generated router can be unit-tested
  and diffed without synthesizing a stack. `PreviewDeploymentProps.unversioned` is accepted and
  **ignored** — see the Epoch 2 deliverables for why previews use a single `BucketDeployment`.
- **Thin by construction.** `Site` and `PreviewSite` together are one distribution each, one
  bucket each, one function, one KVS, DNS, and optionally one pool. Data storage, queues,
  tables, secrets for the app: the consumer's own constructs, in its own stacks, passed in as
  function URLs. The `backends` map is the only contract between the three constructs.
- **Consumer-owned CloudFront logic** goes in `additionalBehaviors` (prod) and
  `behaviorOverrides` (both). The limit the prompt anticipated: a consumer cannot attach its
  own viewer-request function to a preview behavior, because the router owns that slot; it
  can attach viewer-response functions and any origin-side config.
- **What thai and yahn express today** is expressible: a backend pointing at an imported
  production function URL (thai's frontend mode) is just `backends: { api: importedUrl }` in a
  PR stack; yahn's origin-decides cache policy is a `cachePolicy` prop; both sites' two-Lambda
  split is two entries in `backends`.
- **Onboarding target**: four stacks, ~60 non-import lines of CDK. **[revised, Epoch 5] Measured:
  178 by hand, 45 through `defineSiteStacks()`** (`scripts/count-consumer-cdk.sh`, which excludes
  blank, `import` and comment lines and says so). The refactor was proven to be a no-op the same way
  Epoch 3's `behaviors.ts` extraction was: `cdk synth` of `CdkCoreShared`, `CdkCorePreview` and
  `CdkCoreGithubOidc` is byte-identical before and after, and `CdkCoreSite` differs only in the
  `AWS::CDK::Metadata` analytics blob, whose construct-type list reordered.

## Epochs

Each epoch is one fresh session. Every epoch section has the same parts: Goal, Deliverables,
Files, Acceptance test (the exact command a later session runs to confirm this epoch held),
Delegation (what goes to sonnet), Teardown (what AWS resources exist afterwards and how they
go away), If blocked. Epoch numbers are stable; do not renumber when inserting work — add
`Epoch 3b`.

### Epoch 0 — Plan and session mechanism (done 2026-09-06, this file)

Deliverables: `plan.md`, `docs/prior-art.md`, `docs/research/*.md`, `progress.md`,
`CLAUDE.md`, `.claude/skills/{epoch,handoff}`, `.claude/agents/{implementer,verifier}`,
`.claude/settings.json`, `.gitignore`. No AWS resources. Acceptance: `git log` shows the
commit; `/epoch 1` in a fresh session prints the Epoch 1 section.

### Epoch 1 — Monorepo, reference app, local dev, local e2e, CI (done 2026-09-06)

**Goal.** A credential-free local loop that a later session can trust: `pnpm dev` up in under
10 s, `pnpm verify` green, Playwright green locally, CI running the same on every PR. The
package compiles but exports only types and stubs. Nothing touches AWS.

**Deliverables.**
- `pnpm-workspace.yaml` (`packages/*`, `apps/*`, `infra`, `e2e`) with a `catalog:` block;
  root `package.json` scripts: `dev`, `build`, `typecheck`, `lint`, `test`, `e2e`, `verify`
  (= lint + typecheck + test + build). **[revised, Epoch 1]** The `e2e` package's own script
  is named `e2e`, not `test`, and root `e2e` is `pnpm --filter e2e run e2e`: named `test` it
  was swept into `pnpm -r run test` inside `verify`, so every CI job ran the browser suite
  twice and `verify` stopped being runnable without browsers. Root `dev` is
  `pnpm --filter @tylerschloesser/cdk-core run build && pnpm -r --parallel run dev`, because
  the package is consumed as built `dist/` (below) and Vite and tsx need it to exist. `esbuild` as a **root** devDependency. TypeScript
  `~6.0` (not 7 — see yahn's note about `@css-modules-kit`; the reference does not need CSS
  Modules, so plain TS 6 + `verbatimModuleSyntax` + `erasableSyntaxOnly`). oxlint. No
  formatter; no semicolons; single quotes.
- `packages/cdk-core`: `package.json` (`name: @tylerschloesser/cdk-core`, `type: module`,
  `exports: { ".": ..., "./auth/browser": ..., "./auth/server": ... }`, `bin: { "cdk-core": ... }`,
  `peerDependencies: aws-cdk-lib ^2.268, constructs ^10`), `src/index.ts` exporting the
  interfaces from the Construct API section with constructors that `throw new Error('not
  implemented: Epoch 2')`, `src/auth/browser.ts` and `src/auth/server.ts` with the **local
  mode** implemented (dev login, `dev:<name>` tokens, `apiFetch` with `x-id-token` and the
  SHA-256 body hash, `readSse`), `src/bin/sweep.ts` stub. Build with `tsc` to `dist/`
  (handlers get an esbuild step in Epoch 2). Vitest for `readSse` and the hash.
- `apps/web`: Vite + React, routes `/` (hello, shows `__config.json` mode and the user),
  `/auth/callback`, a "Ping" button (`GET /api/ping` → `pong`), an "Echo" form
  (`POST /api/echo` with a body — exercises the body hash), a "Stream" button that reads
  `GET /events/tick?n=5` (one SSE event per 500 ms) and renders each as it arrives. Dev
  server serves `/__config.json` `{mode:'local'}` and proxies `/api`, `/events`.
- `apps/api`: Hono; `createApiApp()` (`/api/ping`, `/api/echo`, `/api/me` requiring auth) and
  `createEventsApp()` (`/events/tick` SSE with `: keepalive` comments every 10 s and an
  `id:` per event); `src/server.ts` runs both on `:3001`/`:3002`; `src/lambda-api.ts`
  (`handle`) and `src/lambda-events.ts` (`streamHandle`) entry points, unused until Epoch 2.
- `e2e/` Playwright: `smoke.spec.ts` (page loads, mode shown), `api.spec.ts` (ping, echo),
  `sse.spec.ts` (five events arrive with ≥ 400 ms between the 1st and 5th and the 2nd within
  1.5 s of the 1st — timing, not just content), `auth.spec.ts` (dev login → `/api/me` shows
  the user). One config, two targets (`PLAYWRIGHT_BASE_URL`), local target boots `pnpm dev`.
- `.github/workflows/ci.yml` (verify + e2e, no AWS), the GitHub repo created
  (`gh repo create tylerschloesser/cdk-core --public --source . --push`), branch protection
  off (solo). **[revised, Epoch 1]** The browser install step is
  `pnpm --filter e2e exec playwright install --with-deps chromium`: `@playwright/test` is a
  dependency of the `e2e` package, not of the root, so a bare `pnpm exec playwright` fails
  with "Command not found" — CI's first run died on exactly that.
- `README.md` (short, for people), `.claude/rules/typescript-config.md`, `.claude/rules/testing.md`.

**Files.** Everything above; `plan.md` Status; `progress.md`.

**Acceptance test.**
```
pnpm install && pnpm verify && pnpm e2e
# and, timed:
( pnpm dev & ) ; t0=$(date +%s); until curl -fsS localhost:5173 >/dev/null && curl -fsS localhost:3001/api/ping | grep -q pong; do sleep 0.5; done; echo "dev up in $(( $(date +%s) - t0 ))s"   # must print ≤ 10
```
CI green on a throwaway PR.

**[revised, Epoch 1] Result.** All three parts passed at `6c2b3c3`; CI run `34056658137` was
green (`7 passed`). The timed command printed `dev up in 2s`. Measured properly over 7
interleaved samples: **1.14 s** warm (0.91–1.15) and **2.85 s** cold with `dist/` wiped
(2.63–3.70), against a 10 s budget.

**Delegation.** Sonnet `implementer` chunks (each with its check): workspace scaffold
(`pnpm install` succeeds); `apps/api` (`curl :3001/api/ping`); `apps/web` (`pnpm build`
succeeds, `vite preview` shows the page); `readSse` + hash unit tests (`pnpm test`); each
Playwright spec (`pnpm e2e e2e/<file>`); `ci.yml` (`actionlint` or a green run). Orchestrator
owns: package `exports` layout, the Construct API stubs, the SSE timing assertion, repo
creation, the handoff.

**Teardown.** No AWS resources.

**If blocked.** TypeScript 6 vs 7 tooling churn: pin to what `thai.ler.dev` pins. Playwright
browsers: `pnpm exec playwright install chromium`. If `gh repo create` needs a scope, ask the
user to run `! gh auth refresh -s repo`.

### Epoch 2 — Preview topology: `PreviewSite`, `PreviewDeployment`, the routing spike

**Goal.** A PR-numbered stack deploys in minutes onto a shared preview distribution and is
reachable at `https://pr-<n>.preview.cdk-core.ty.ler.dev` with assets, a buffered API, a
streaming SSE endpoint, and clean teardown. No auth yet (backends run with `AUTH=none`,
`/api/me` returns 401 — and the machine-user pieces are Epoch 4).

**Order matters.** Do the spike before writing constructs:
1. By hand (CLI/console is fine, but record commands in `docs/spikes/2026-xx-oac-spike.md`):
   a KVS, a JS 2.0 function that `updateRequestOrigin`s to a `RESPONSE_STREAM` function URL
   with `AuthType: AWS_IAM` and inline `originAccessControlConfig{originType: lambda}`, both
   `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction` granted to `cloudfront.amazonaws.com`
   with the distribution `SourceArn`. Prove `curl -N` streams. If it 403s, try the D1 fallback
   (`AuthType: NONE` + `customHeaders` secret). Write the result into D1 as `[revised]`.
2. Prove the URI-rewrite cache-key claim (D10): two prefixes, same path, different bodies,
   no cross-contamination after a warm hit.
3. Then build the constructs.

**Deliverables.**
- `siteCertificate`, `PreviewSite`, `PreviewDeployment` implemented per the Construct API,
  minus `auth` (props accepted, ignored with a synth-time warning until Epoch 4).
- The router function source generated from backends (`src/router/render.ts` → string; unit
  test that the output is < 10 KB and contains each path pattern), covering: unknown host →
  404, bounce host (D5, minus the auth exchange it triggers — it is pure redirect logic and
  can ship now), assets rewrite + SPA fallback, backend origin override with `readTimeout`.
- The custom-resource handler `src/handlers/preview-resources.ts` bundled by esbuild into
  `dist/handlers/preview-resources/index.js` (SDK clients bundled, not external), handling
  `ResourceType: KvsRoute` (Create/Update: describe → `UpdateKeys` puts; Delete: describe →
  `UpdateKeys` deletes; retry on `ConflictException`/`ValidationException` with 100–500 ms
  jitter, ≤ 10 attempts; Delete of a missing key is success). A vitest with a fake client
  covers the retry loop.
- `PreviewDeployment`: `BucketDeployment` to `pr-<n>/` (`retainOnDelete: false`, `prune`
  scoped, `__config.json` from `Source.jsonData`, `distributionPaths: ['/pr-<n>/*']`),
  per-backend `CfnPermission`s scoped to the preview distribution ARN, the `KvsRoute` custom
  resource, stack + resource tags `cdk-core:pr`.
  **[revised, Epoch 2] One `BucketDeployment`, not two, and everything is
  `public, max-age=0, must-revalidate`** rather than hashed-immutable + unversioned-`no-cache`.
  Two deployments sharing a prefix with `prune: true` delete each other's files, and a second
  custom-resource invocation sits on the critical path of every push for a caching win a
  short-lived preview never collects. `Site` (Epoch 3) still needs the real split.
  **[revised, Epoch 2]** The KVS value carries a synth-time `deployedAt`, so the custom
  resource updates on every deploy and re-puts the key — a preview whose key was swept heals on
  the next push instead of staying dark. Costs ~2 s; makes `cdk diff` on a PR stack always
  non-empty. `unversioned` on the props is accepted and ignored.
- `infra/` for the reference: `bin/app.ts` with `CdkCoreShared`, `CdkCorePreview`,
  `CdkCore-pr-<n>` (context `pr`, validated), Lambdas via `NodejsFunction` (`NODEJS_22_X`,
  arm64, `externalModules: ['@aws-sdk/*']`), the events URL `RESPONSE_STREAM`.
- `scripts/verify-preview.sh <n>`: curls `/`, `/api/ping`, `/api/echo` (POST with hash),
  `/events/tick?n=5` with `curl -N` and timestamps, and a nonexistent host expecting 404.
  **[revised, Epoch 5] The SSE check needs an ID token, and had been silently failing since
  Epoch 4.** Making `/events/*` require auth turned the unauthenticated stream into a 401, and
  nothing caught it: Epoch 4's own handoff only ran the script in `--expect-absent` mode, where
  a failing request is the expected result. It now takes `--id-token` (or `CDK_CORE_ID_TOKEN`)
  and, given no token, asserts the endpoint answers **401** — which is a better check than the
  one it replaced, because it proves from the outside that the preview API enforces auth. The
  script stays credential-free; minting the token is `scripts/preview-login.sh`'s job.
- `.claude/rules/cdk.md` with the gotchas that bit (start from yahn's five).

**Files.** `packages/cdk-core/src/{preview-site,preview-deployment,certificate,router,handlers}/**`,
`packages/cdk-core/package.json` (build script), `infra/**`, `scripts/verify-preview.sh`,
`docs/spikes/*.md`, `.claude/rules/cdk.md`, `plan.md`, `progress.md`.

**Acceptance test.**
```
pnpm build && AWS_PROFILE=admin pnpm --filter infra exec cdk deploy CdkCoreShared CdkCorePreview --require-approval never
AWS_PROFILE=admin pnpm --filter infra exec cdk deploy CdkCore-pr-1 -c pr=1 --require-approval never   # time it
scripts/verify-preview.sh 1     # all checks pass; SSE shows 5 events ≥ 400 ms apart
AWS_PROFILE=admin aws cloudformation delete-stack --region us-east-1 --stack-name CdkCore-pr-1 && aws cloudformation wait stack-delete-complete ...
scripts/verify-preview.sh 1     # every check now fails with 404, and:
AWS_PROFILE=admin aws cloudfront-keyvaluestore list-keys --kvs-arn "$(aws ssm get-parameter --name /cdk-core/cdk-core.ty.ler.dev/preview/kvsArn --query Parameter.Value --output text --region us-east-1)" --region us-east-1   # no pr-1 key
AWS_PROFILE=admin aws s3 ls s3://<preview-bucket>/pr-1/ --region us-east-1   # empty
```
Record the PR-stack deploy time in `progress.md`; target ≤ 3 min for a first deploy.

**[revised, Epoch 2] Result: all of it passed at `b7d1521`.** First `CdkCore-pr-1` deploy
**102 s** (target ≤ 180 s); `scripts/verify-preview.sh 1` **7 passed, 0 failed** including the
signed POST and an SSE stream with 2004 ms of spread across 5 events; teardown **62 s**; after
it, `verify-preview.sh 1 --expect-absent` **7 passed** (every check 404s), `list-keys` returned
`{"Items": []}` and the `pr-1/` prefix was empty. Beyond the plan's list: three repeat deploys
measured **32 / 33 / 33 s**, and the Playwright suite ran against a deployed target for the
first time — `PLAYWRIGHT_BASE_URL=https://pr-1.preview.cdk-core.ty.ler.dev pnpm e2e` →
`5 passed, 2 skipped` (the two skips are Epoch 1's dev-login tests, which Epoch 4 replaces with
a machine-auth fixture).

**Delegation.** Sonnet: router-source renderer + size test; handler retry loop + fake-client
test; `verify-preview.sh`; `infra/bin/app.ts` scaffolding from the API; `cdk.md` first draft
from yahn's. Orchestrator: the spike (all AWS), construct wiring, every deploy, the timing
measurement, D1/D10 `[revised]` edits.

**Teardown.** `CdkCore-pr-1` is deleted in the acceptance test. `CdkCorePreview` and
`CdkCoreShared` stay (a distribution, a bucket, a KVS, a function, a cert, two DNS records:
≈ $0 idle). To remove everything: `cdk destroy CdkCorePreview CdkCoreShared`. Write both
commands into `progress.md`.

**If blocked.** OAC via `updateRequestOrigin` fails → D1 fallback, `[revised]`. KVS write
`AccessDenied` from Lambda → check the SigV4A/STS note in D2 and the handler's `region`
config (`us-east-1`, KVS endpoint is global). Cache-key test fails → switch assets to a
per-PR bucket (`PreviewDeployment` creates it, adds the OAC bucket policy for the preview
distribution ARN) and `[revised]` D10. SSO expired → ask the user for `! aws sso login --profile admin`.

### Epoch 3 — `Site` (prod), `GithubDeployRole`, the three workflows, the sweeper

**Goal.** `https://cdk-core.ty.ler.dev` is live from `deploy.yml`; a real PR on this repo
gets a preview, its e2e runs against it, closing it tears it down, and `cleanup.yml` finds
nothing left. Still no auth.

**Deliverables.**
- `Site` per the Construct API (minus `auth`), sharing internals with `PreviewSite` where
  identical (bucket deploy pair, SPA function, backend behavior factory). `CachePolicies.originDecides`.
- `GithubDeployRole` (imports the OIDC provider; both `sub` forms; `sts:AssumeRole` on the
  bootstrap roles; `cloudformation:ListStacks` on `*`; `DescribeStacks`/`DeleteStack` on
  `stack/<prefix>-pr-*`; `ssm:GetParameter` on the site's prefix; KVS `DescribeKeyValueStore`/
  `ListKeys`/`DeleteKey`/`UpdateKeys` on the KVS ARN; `s3:ListBucket`/`DeleteObject` on the
  preview bucket). Deployed **by hand** as `CdkCoreGithubOidc`; repo variable
  `AWS_DEPLOY_ROLE_ARN` set with `gh variable set`.
- `cdk-core sweep` per the Architecture section, with `--dry-run`, unit-tested against fakes.
- Workflows in `.github/workflows/`: `deploy.yml` (verify → e2e local → credentials → deploy
  Shared, Preview, Site → wait `/api/ping` → e2e against prod), `pr-preview.yml`
  (`opened|synchronize|reopened`, same-repo guard, build, deploy `CdkCore-pr-$PR
  --exclusively -c pr=$PR`, poll `https://pr-$PR.preview.cdk-core.ty.ler.dev/api/ping` until
  200 (KVS propagation), e2e with `PLAYWRIGHT_BASE_URL`, sticky comment with URL + status +
  timings), `pr-teardown.yml` (`closed`, same concurrency group, look-before-comment,
  `delete-stack` without wait), `cleanup.yml` (daily cron + dispatch, `pnpm exec cdk-core sweep`).
  All `cancel-in-progress: false` except `ci.yml`.
- Workflow templates copied into `plugins/cdk-core/skills/new-site/templates/` (Epoch 5 wires
  the skill; the copies are made now so they cannot drift from the proven ones — a test greps
  that they are identical modulo the site name).
- A $10/month AWS Budget alarm with email (`aws budgets`), created by hand; command in `progress.md`.

**Acceptance test.**
```
gh workflow run deploy.yml && gh run watch          # green; https://cdk-core.ty.ler.dev/api/ping → pong
git checkout -b epoch-3-throwaway && git commit --allow-empty -m 'preview smoke' && gh pr create --fill
gh run watch                                        # pr-preview green; comment shows URL; note "push → comment" time
PLAYWRIGHT_BASE_URL=https://pr-<n>.preview.cdk-core.ty.ler.dev pnpm e2e      # green locally too
gh pr close <n> && gh run watch                     # teardown green
sleep 300; gh workflow run cleanup.yml && gh run watch                          # "nothing to delete", exit 0
pnpm exec cdk-core sweep --dry-run ...              # same, locally with AWS_PROFILE=admin
```
Targets recorded in `progress.md`: push → preview comment ≤ 5 min first deploy, ≤ 3 min
repeat; teardown workflow ≤ 2 min; sweeper dry-run finds nothing.

**[revised, Epoch 3] Result: all of it passed, in a different order.** Two orderings in the
list above are not runnable as written, and the reasons are worth keeping:
`gh workflow run deploy.yml` needs the workflow on the **default branch**, so nothing in this
list can run before the epoch's PR merges; and a first CloudFront create is a four-minute round
trip, so `CdkCoreSite` was created **by hand** first (223.8 s) to keep construct bugs on a local
loop, after which `deploy.yml` proved the workflow rather than the construct. What was measured:
prod live and `pnpm e2e` green against it (**5 passed, 2 skipped**); `deploy.yml` green on both
`push` (148 s) and `workflow_dispatch` (103 s); `pr-preview.yml` green four times, deploying a
**new** PR stack in 95 s and 93 s and a **repeat** in 29 s and 33 s, with **88 s** from a real
`git push` to the sticky comment; `scripts/verify-preview.sh` **7 passed, 0 failed** against
both PR previews; `pr-teardown.yml` green in **14 s**, with the stack fully gone **86 s** after
`gh pr close`, and `verify-preview.sh <n> --expect-absent` **7 passed**; and
`cdk-core sweep --dry-run` printing `(nothing to reconcile)`, exit 0, with the KVS and the
preview bucket confirmed empty. The IAM check the delegation asked for:
`simulate-principal-policy` returns **implicitDeny** for `cloudformation:DeleteStack` on
`YahnAppStack-prod`, `ThaiLerDevSiteStack`, `CDKToolkit` and even `CdkCoreSite`, and **allowed**
only on `CdkCore-pr-*`. Full numbers and the budget command in `progress.md`.

**[revised, Epoch 3] Five workflows, not "the three".** The section title undercounts its own
deliverables list; `ci.yml` from Epoch 1 plus the four here.

**Delegation.** Sonnet: `sweep` implementation + tests from the spec; the four workflows from
yahn's/thai's (each checked with `actionlint`); `GithubDeployRole` from yahn's stack;
README deploy section. Orchestrator: `Site` construct, the hand deploys (OIDC role, budget),
the throwaway PR, timings, the IAM `simulate-principal-policy` check that `DeleteStack` on
`YahnAppStack-prod` and `ThaiLerDevSiteStack` is `implicitDeny` for the new role.

**Teardown.** After this epoch the account holds `CdkCoreShared`, `CdkCorePreview`,
`CdkCoreSite`, `CdkCoreGithubOidc` — all idle-free except CloudFront/S3 pennies. PR stacks
are transient. Full removal: `cdk destroy CdkCoreSite CdkCorePreview CdkCoreShared CdkCoreGithubOidc`
plus `gh variable delete AWS_DEPLOY_ROLE_ARN`.

**If blocked.** `AccessDenied` in a workflow → the role, not the bootstrap roles; hand-redeploy
`CdkCoreGithubOidc`. `pull_request` workflows only run from a PR whose merge ref contains
them → base the throwaway PR on the epoch branch, as thai's rule says. Preview `/api/ping`
never 200s within 5 min → check KVS key exists (`list-keys`), then function logs
(CloudWatch `/aws/cloudfront/function/...`).

### Epoch 4 — Auth: Cognito + Google, the bounce, machine login, authenticated e2e

**Goal.** Google login works on prod and on a preview through the bounce; Claude can log
into a preview without a browser or a Google account, then drive the UI with Playwright as
that user, including an authenticated SSE stream. The prod stack contains no password path.

**Human actions first (ask, do not invent). [revised, Epoch 4] Both are done.** (1) In Google
Cloud console create one OAuth 2.0 Web client (consent screen External/Testing, scopes
`openid email profile`, authorized domain `amazoncognito.com`), add redirect URIs
`https://cdk-core.auth.us-east-1.amazoncognito.com/oauth2/idpresponse` and
`https://cdk-core-preview.auth.us-east-1.amazoncognito.com/oauth2/idpresponse`, and add the
user's Google account as a test user. (2) `aws secretsmanager create-secret --name
cdk-core/google-oauth --secret-string '{"clientId":"...","clientSecret":"..."}' --region us-east-1`.
Until both exist, build everything and stop before deploying. Note the two prefixes here are
**not** what `AuthProps.domainPrefix` defaults to (`cdk-core-ty-ler-dev`), so `bin/app.ts`
passes them as literals — the value that has to match a human's console typing is not a
derivation. Cheap check that the pair line up, no browser needed: fetch the Cognito
`/oauth2/authorize` URL, follow its `Location`, and confirm Google answers with a sign-in page
rather than `Error 400: redirect_uri_mismatch`.

**Deliverables.**
- `Site.auth`: `UserPool` (Essentials, self-sign-up off, email as username alias not needed),
  `UserPoolIdentityProviderGoogle` reading the secret, `UserPoolDomain` prefix,
  `UserPoolClient` (auth-code grant, scopes `openid email profile`, callback
  `https://<domain>/auth/callback`, logout `https://<domain>/`, `supportedIdentityProviders:
  [GOOGLE]`, ~~`authFlows: {}` **explicitly**~~ **[revised] `explicitAuthFlows` pinned on the
  L1**, no secret), `authEnvironment`. `authFlows: {}` renders *no* `ExplicitAuthFlows`, which
  makes Cognito apply legacy defaults including SRP — the opposite of the intent. Also required
  and not obvious: `attributeMapping: { email: GOOGLE_EMAIL }` (without it the ID token has no
  `email` claim and every verified token is rejected), and `client.node.addDependency(googleIdp)`
  (a client naming `Google` fails to create before the provider exists).
- `PreviewSite.auth`: preview pool with the same Google IdP, browser client with callback
  `https://oauth.preview.<domain>/`, `machine` client with `authFlows: { userPassword: true }`,
  the `PoolUser` custom-resource type in the existing handler (AdminCreateUser SUPPRESS +
  AdminSetUserPassword permanent, password read from the secret at runtime, never in the
  template), the secret `<domain>/preview-machine-user`, SSM params `authIssuer`,
  `authClientId`, **[revised] `authDomain`, `authMachineClientId`**, `machineSecretArn`. The
  prod pool is untouched by any of this.
- `auth/browser` and `auth/server` real modes per Architecture; `__config.json` carries
  `auth`; refresh; logout.
- `apps/api` `/api/me` returns `{sub, email}`; `/events/tick` requires auth.
- e2e: `auth.spec.ts` gains a preview path — a fixture that, when `PLAYWRIGHT_BASE_URL` is
  set, reads the machine secret (`aws secretsmanager get-secret-value`, profile from env),
  runs `initiate-auth`, and seeds `localStorage["cdkcore:auth"]` via `addInitScript`; then
  asserts `/api/me` shows `claude@…` and the SSE stream delivers 5 timed events with the
  token. A negative test: the same tokens against `https://cdk-core.ty.ler.dev/api/me` → 401.
  **[revised] Three targets, not two.** Production has no machine user and cannot have one —
  that is A7 — so `e2e/fixtures.ts` exports `TARGET` (`local | preview | prod`), `machineAuth`
  throws against prod, and the authenticated specs skip there with a `test.skip` at
  **`test.describe` scope** (Playwright resolves fixtures before running a body, so an in-body
  skip is too late). The cost: `deploy.yml`'s post-deploy run no longer exercises production's
  SSE stream, since `/events/tick` now requires auth.
- `scripts/preview-login.sh <n>` printing a bearer-style `x-id-token` for `curl`.
- `.claude/rules/auth.md`.

**Acceptance test.**
**[revised]** the `xargs -I{}` form cannot work: `xargs -I` caps a replacement line at 255
bytes and a Cognito ID token is ~1050, so it fails with `command line cannot be assembled, too
long` before curl runs. `$(…)` is the working form.

```
gh pr create ... && gh run watch          # preview green including the auth spec
curl -fsS -H "x-id-token: $(scripts/preview-login.sh <n>)" https://pr-<n>.preview.cdk-core.ty.ler.dev/api/me   # {"sub":..,"email":..}
curl -sS -o /dev/null -w '%{http_code}\n' -H "x-id-token: $(scripts/preview-login.sh <n>)" https://cdk-core.ty.ler.dev/api/me   # 401
aws cognito-idp describe-user-pool-client --user-pool-id <prod pool> --client-id <prod client> --query 'UserPoolClient.ExplicitAuthFlows'   # ["ALLOW_REFRESH_TOKEN_AUTH"]
aws cognito-idp list-users --user-pool-id <prod pool> --query 'Users[?UserStatus!=`EXTERNAL_PROVIDER`]'   # []
```
And a manual check by the user: Google login on `https://cdk-core.ty.ler.dev` and on the PR
preview both land back on the page signed in.

**Delegation.** Sonnet: `auth/browser` PKCE + token storage from the spec (vitest with a
fake token endpoint); `auth/server` verifier wrapper; the Playwright fixture; `auth.md`.
Orchestrator: pool/client wiring (every flag above is load-bearing), the bounce state format,
the `PoolUser` handler, all deploys, the negative tests, the human-action prompts.

**Teardown.** Two user pools ($0 idle), one secret ($0.40/month), the Google secret
($0.40/month). Both pools delete with their stacks. **[revised]** the machine secret *is*
stack-owned, but that changes nothing about the command: a CloudFormation delete schedules a
secret for deletion with a recovery window and the **name stays reserved** until it elapses, so
recreating `CdkCorePreview` inside that window needs
`aws secretsmanager delete-secret --force-delete-without-recovery` first. Both commands are in
`progress.md`.

**If blocked.** Google redirect mismatch → the pool domain prefix must equal what was typed
into Google; print both. Cognito `InvalidParameterException` on IdP creation → the secret
JSON shape. Bounce loops → the nonce/PR parse in the router; test the function with
`aws cloudfront test-function` (event JSON in `docs/spikes/`).

### Epoch 5 — Publish, the plugin, the skills, onboarding proof, Claude end-to-end

**Goal.** A new consumer repo could adopt cdk-core from npm and the plugin alone, and Claude
can take a PR from open to verified-in-preview with no human step.

**Human action.** `npm login` (once). Publishing itself is done by the session.
**[revised, Epoch 5] Two more were needed and neither was anticipated.** The npm **scope had to
be created**: `npm whoami` is `tyle`, so `@tylerschloesser` was not a personal scope and the
publish failed `404 … Scope not found` — the user created a free npm *organization* of that
name. And the upload itself needs a **2FA bypass**: the user's second factor is a passkey, so
`--otp` does not apply, and it took either a classic *Automation* token or a real TTY where
npm's browser auth flow can run. 0.1.0 went out from the user's own terminal.

**Deliverables.**
- Package hygiene: `files`, `dist/` with handlers, `exports` map with types, `README.md` in
  the package (install, the three constructs, the four-stack layout, the skills), version
  `0.1.0`, **[revised, Epoch 5] `pnpm publish --access public`** — never `npm publish`: every
  version in this workspace is a `catalog:` specifier and only pnpm rewrites those to real
  ranges as it packs, so an npm-packed tarball ships `"aws-jwt-verify": "catalog:"` and dies in
  the consumer's install with `EUNSUPPORTEDPROTOCOL`. Caught by `consumer-smoke.sh --pack`
  before 0.1.0 went out. Then git tag `v0.1.0`. Reference switches from
  `workspace:*`? **No** — it stays on `workspace:*` so this repo dogfoods HEAD; a
  `scripts/consumer-smoke.sh` creates a temp dir, installs the published version, and
  synthesizes the four stacks from `templates/` to prove the tarball works.
- `.claude-plugin/marketplace.json` (`name: tylerschloesser`, plugin `cdk-core` at
  `./plugins/cdk-core`), `plugins/cdk-core/.claude-plugin/plugin.json`, skills:
  - `preview` — how previews work (hostnames, timings, what a comment looks like), how to
    open a PR and wait for it (`gh pr create`, `gh run watch`, poll `/api/ping`), how to run
    e2e against it, how to read logs, how teardown and the sweeper behave, what never to do
    (`delete-stack` on anything not `-pr-<n>`).
  - `preview-auth` — the machine-auth path: secret name, `initiate-auth`, `x-id-token` for
    curl, the Playwright `addInitScript` seed, the 5-failures lockout, and why none of it
    works on prod.
  - `new-site` — onboarding: the four stacks from `templates/*.ts`, the workflows from
    `templates/workflows/`, `.claude/settings.json` snippet with `extraKnownMarketplaces` +
    `enabledPlugins`, the human actions (OIDC stack by hand, repo variable, Google redirect
    URIs, secrets), and the checklist to verify.
  - `agents/` in the plugin: `implementer`, `verifier` (copies of this repo's).
- This repo's `.claude/settings.json` gains `extraKnownMarketplaces`/`enabledPlugins` so the
  repo tests its own plugin; the standalone `.claude/skills` stay (`epoch`, `handoff`).
- Line count check: `scripts/count-consumer-cdk.sh` prints non-blank, non-import lines of
  `infra/bin/app.ts` + `infra/lib/*.ts`; target ≤ 60 (record the number; if it is over, add a
  `defineSiteStacks()` convenience and re-count, but keep the constructs primary).
- The Claude end-to-end run: from a **fresh session in this repo with the plugin loaded**,
  the prompt "Change the ping response to `pong!` and verify it in a PR preview" must result
  in a PR, a green preview run, an authenticated e2e pass, and a comment linking the preview —
  with the user doing nothing. Record the transcript summary in `progress.md`.

**Acceptance test.**
```
npm view @tylerschloesser/cdk-core version        # 0.1.0
scripts/consumer-smoke.sh                          # synth of 4 stacks + a PR stack from the tarball
scripts/consumer-smoke.sh --pack                   # the same, pre-publish, from `pnpm pack`
claude plugin validate ./plugins/cdk-core          # passes
scripts/count-consumer-cdk.sh                      # ≤ 60
# the end-to-end run above, verified by `gh pr view <n> --json state,comments`
```

**Delegation.** Sonnet: package README, skill bodies from this plan + rules (verifier checks
every command in a skill actually runs), `consumer-smoke.sh`, `count-consumer-cdk.sh`,
`marketplace.json`/`plugin.json`. Orchestrator: publish, the end-to-end run, the final Status
block.

**Teardown.** Nothing new in AWS. The npm version is permanent (unpublish window 72 h).

**If blocked.** `npm publish` 403 → scope/2FA; ask the user. Plugin skills not showing →
`/reload-plugins`, then `claude plugin validate`. The end-to-end run stalls on a permission
prompt → note the exact tool call in `progress.md`; that is a finding about the skills, not a
failure to hide.

### Epoch 6 — Hardening and measurements (optional, after 5)

Race two PR deploys and confirm both KVS keys land; cancel a workflow mid-deploy and confirm
the sweeper's next run is clean; force-delete a branch; measure `ComputeUtilization` of the
router at p99 and the added latency vs prod (interleaved samples, ≥ 30 pairs — yahn's lesson);
consider trusted publishing for npm; decide whether `.claude/skills/{epoch,handoff}` become a
second plugin in this marketplace (`epochs`) for other repos — recommendation recorded in D8:
they are generic, and the marketplace already exists here, so a second plugin in this repo is
cheaper than a separate repo until a third consumer appears.

**[revised, Epoch 5] What Epoch 6 now owes, in priority order.** The first item is the only
unmet acceptance criterion and the only one that is not optional if the sweeper is to be
trusted:

1. **A8 — prove the sweeper deletes.** It has never removed anything real: every live run has
   found an open PR (kept, correctly) or nothing. Orphan a key, a `pr-<n>/` prefix and a stack
   deliberately, and watch it reclaim all three. Until then the daily `cleanup.yml` is an
   untested safety net.
2. **Race two PR deploys** and confirm both KVS keys land; cancel a workflow mid-deploy and
   confirm the next sweep is clean.
3. **Measure KVS propagation on the *create* side.** The delete side is now measured (~1 min
   past the stack delete, revision 25); the create side has never had to wait, so
   `pr-preview.yml`'s 5-minute poll is unexercised near its limit.
4. **Router `ComputeUtilization` at p99 and the added latency vs prod** — interleaved samples,
   ≥ 30 pairs, yahn's lesson.
5. **Trusted publishing for npm.** 0.1.0 went out from a laptop, and the account's 2FA is a
   passkey, which makes every manual publish awkward.
6. **A second plugin (`epochs`) for `.claude/skills/{epoch,handoff}`** — cheaper now than when
   D8 recorded the recommendation, because the marketplace exists and is proven.
7. **Walk the `new-site` checklist on a real second repo.** Everything in it is verified
   command by command; nothing in it has been done end to end by someone starting from nothing,
   which is the only test of an onboarding document that counts.

**[revised, Epoch 6] What was actually done, against that list.** Items 1-6 are done; item 7
was skipped by the user's explicit decision, because a real second site is most of a session on
its own. Numbers are in `progress.md`.

1. **A8 met.** Three stacks for closed PRs plus an orphan key and prefix under a fourth; one
   sweep reclaimed all of it. The sweeper's code needed no change — it was right, it had
   simply never been given anything to delete.
2. **The race is measured, the cancel is measured, the force-deleted branch is measured.**
   Both concurrent deploys landed their keys; a run cancelled mid-`CREATE_IN_PROGRESS` left a
   working preview 87 s later and a clean sweep; a deleted branch tore its stack down in
   ~2.5 min. What is *not* measured is the retry loop actually retrying — it logged nothing at
   the time, and now does.
3. **Create-side propagation: median 29.0 s for a new hostname**, ~1.4 s for one the edge has
   seen. D2 carries the numbers.
4. **Router `ComputeUtilization` p99 26.4-30.0%, max 30**, and **no measurable added latency** —
   40 interleaved pairs put the per-pair delta at -5.2 ms, i.e. under the noise floor.
5. **Trusted publishing is built** (`publish.yml`), and blocked only on one npmjs.com setting.
6. **The `epochs` plugin exists**, and D8 records the shape.

One thing this epoch found that the list did not anticipate: **a torn-down PR stack leaves its
CloudWatch log groups behind** — Lambda creates them, not CloudFormation, so nothing deletes
them, and all 55 have no retention. They cost nothing measurable today and the sweeper does not
know about them. `progress.md` has the fix and why it was not applied late in an epoch.

## Acceptance criteria

Per-epoch tests are above. The overall bar, checked at the end of Epoch 5 and recorded with
numbers in `progress.md` (the user adjusts the targets; these are proposals):

| # | Criterion | Target | Proven by |
| --- | --- | --- | --- |
| A1 | PR preview reachable from push | ≤ 5 min first deploy, ≤ 3 min repeat (yahn: ~6 min) | **met, Epoch 3 [revised]**: new stack 95 s / 93 s, repeat 29 s / 33 s at the deploy step; **88 s** from a real `git push` to the sticky comment. Four observations, not a randomized study — the headroom is ~2x |
| A2 | Teardown leaves zero billable resources | 0 stacks, 0 KVS keys, 0 `pr-*/` prefixes after close | **met, Epoch 3 [revised]**: after both throwaway PRs closed, `cdk-core sweep --dry-run` printed `(nothing to reconcile)` and exited 0, `list-keys` returned `{"Items": []}`, and the preview bucket was empty |
| A3 | Onboarding cost | ≤ 60 non-import CDK lines for four stacks; ≤ 30 min of human actions | **met, Epoch 5 [revised]**: **45** lines, from **178** before `defineSiteStacks()` (`scripts/count-consumer-cdk.sh`, which excludes blank, `import` and comment lines and prints the raw count too). The human-actions half is *unmeasured* — the `new-site` checklist has been verified command by command but never walked end to end on a second site. **[Epoch 6]** Still unmeasured, and now deferred by decision rather than by omission: the walk needs a second repo, a second domain and a full set of AWS resources, which the user chose not to spend a session on |
| A4 | Local dev | `pnpm dev` serves the SPA and `/api/ping` within 10 s; no credentials | **met, Epoch 1 [revised]**: 1.14 s warm / 2.85 s cold, medians of 7 interleaved samples |
| A5 | Claude end-to-end | open → preview → authenticated e2e → verified, zero human steps | **met, Epoch 5**, on the second attempt: a fresh `claude -p` session on `main` with the plugin loaded opened **PR #9**, preview green in 97 s (212 s push → sticky comment), e2e passed including the authenticated specs, and it reported back — no human step. The first attempt stopped to ask whether to push; the `preview` skill was silent on that and now is not (revision 26) |
| A6 | SSE | 5 events with ≥ 400 ms spread arrive incrementally through CloudFront, with auth | **met, Epoch 4 [revised]**: with a Cognito ID token through the preview distribution, spread **median 2003 ms (range 2000–2003, 7 samples)** and a 1st→2nd gap of **500 ms (range 499–501)** — the producer's interval exactly. Unauthenticated: 2004 ms preview / 2040 ms production (Epochs 2–3). `deploy.yml` no longer streams against production, because `/events/tick` now needs auth and prod has no machine user |
| A7 | Machine auth absent from prod | prod client `ExplicitAuthFlows` = refresh only; prod pool has no native users; preview token → prod API 401 | **met, Epoch 4**: `["ALLOW_REFRESH_TOKEN_AUTH"]`, `[]`, and 401 — all three read back from the live account |
| A8 | Sweeper | finds and removes a deliberately orphaned key, prefix, and stack (Epoch 6 or by hand in 3) | **met, Epoch 6**: one live `cdk-core sweep` deleted three real stacks (`CdkCore-pr-3/-4/-9`, all closed PRs), one orphaned KVS key and one orphaned `pr-6/` prefix, exit 0. Afterwards `list-keys` was `[]`, the preview bucket was empty, `--dry-run` exited 0 and `verify-preview.sh 9 --expect-absent` was 7 passed / 0 failed. The key and prefix were orphaned under a *different* PR number than any stack on purpose: a stack delete removes its own key and prefix, so one orphaned stack would have proven only one of the three paths |

## Cost guardrails

- **Nothing in this design has an idle cost above pennies.** Per site: two distributions, two
  buckets, one KVS, one function, ≤ 2 pools, ≤ 3 secrets ($0.40/month each). The only way to
  spend real money is leaked PR stacks whose Lambdas get traffic, or runaway streaming
  (Lambda bills full duration even after the client disconnects — keep `/events` timeouts ≤ 5
  min and keepalives cheap).
- **Every AWS-creating epoch lists its teardown** and the handoff records the exact commands.
  A session never ends with a `-pr-<n>` stack alive unless `progress.md` says so and why.
- **Three layers against leaks**: `pr-teardown.yml` on close; the daily sweeper across stacks,
  KVS and S3; the deploy role's IAM scope so neither can touch anything else. Plus the $10
  budget alarm from Epoch 3.
- **Never** `delete-stack`/`destroy` a name not just read back from `list-stacks`; the
  account hosts three other production sites. `.claude/settings.json` does not allowlist any
  destructive AWS call.
- Previews use the **fake/no-op** variant of anything metered (no model calls in the reference).

## Delegation plan

The planning session was Fable; orchestrator sessions run Opus (`claude --model opus`, then
`/epoch <n>`); grunt work goes to the sonnet agents in `.claude/agents/`. Subagents share no
context, so every handoff is self-contained: file paths, the exact change, the one-line check.

**Sonnet (`implementer` → `verifier`)**: scaffolding from a spec (workspace, package
manifests, workflow YAML from a proven template), test writing (Playwright specs, vitest for
pure functions), mechanical implementations with a fake to test against (KVS retry loop, SSE
parser, PKCE helpers, the sweeper's reconciliation), docs and rule drafts, `actionlint`/lint/
typecheck runs, read-heavy exploration that returns only a conclusion (e.g. "does the
published tarball include `dist/handlers`?").

**Opus orchestrator**: every decision that touches the Construct API or a `plan.md` claim;
construct wiring (the props are load-bearing and the failure modes are silent 403s); every
`cdk deploy`/`destroy`, every AWS CLI write, every measurement and the decision it feeds;
review of the integrated diff; the handoff. The per-epoch sections name the split concretely.

**Rules of thumb carried from thai/yahn**: don't delegate a chunk smaller than its handoff;
verify a subagent's confident claim before building on it (yahn lost 60 lines to one);
three samples are not a measurement — interleave and randomize, report a median and range.

## Session mechanism

**Recommendation (D8): files plus two skills, all built-in primitives, committed now.**

What exists in this repo after Epoch 0:

| Piece | Purpose |
| --- | --- |
| `plan.md` | The spec. Status block on top, corrected in place with `[revised]`. |
| `progress.md` | Append-only log, one entry per epoch (or per stop), fixed heading format so `/epoch` can `tail` it. |
| `.claude/skills/epoch/SKILL.md` | `/epoch <n>`: injects the Status block, the progress tail, git state, and the epoch's section via `` !`awk …` ``; states the session rules; ends by demanding `/handoff`. User-invoked only. |
| `.claude/skills/handoff/SKILL.md` | `/handoff [blocked]`: run the acceptance test, append the progress entry, correct `plan.md`, update rules, commit, print `Next: …`. Model-invocable so the orchestrator runs it itself. |
| `.claude/agents/{implementer,verifier}.md` | sonnet workers, same contract as thai/yahn. |
| `CLAUDE.md`, `.claude/rules/*.md` | invariants; `paths`-scoped rules grow per epoch. |
| `.claude/settings.json` | read-only allowlist; nothing destructive. |

How an epoch runs: `claude --model opus` in this repo → `/epoch 3` → the session confirms
Epoch 2's acceptance test still passes, plans chunks, delegates, deploys, measures → `/handoff`
→ commit `Epoch 3 handoff: …` → reply ends with `Next: start a fresh session and run /epoch 4`.
The next session needs nothing from the previous conversation.

Why not more: a `Stop` hook that blocks stopping without a handoff would fire on every turn
and get in the way of ordinary questions; a `SessionStart` hook injecting `progress.md` would
duplicate what `/epoch` injects on demand; `claude -p "/epoch n"` in a shell loop is the
unattended version and can be added as `scripts/run-epoch.sh` when wanted — it is not needed
for the next session to work, which was the bootstrapping constraint. The mechanism is
generic (nothing in the two skills knows about CDK); if it proves out, it becomes a second
plugin in this repo's marketplace (Epoch 6 note), not a separate repo yet.

## Repository layout

**[revised, Epoch 5]** This was the target; it is now what is on disk, with two differences.
There is no `infra/lib/` — the app is one generated file — and `src/define-site-stacks.ts` was
added.

```
cdk-core/
├── plan.md  progress.md  CLAUDE.md  prompt.md  README.md
├── .claude/            skills/{epoch,handoff}  agents/  rules/  settings.json
├── .claude-plugin/     marketplace.json
├── plugins/cdk-core/   .claude-plugin/plugin.json  agents/
│                       skills/{preview,preview-auth,new-site}
│                       skills/new-site/templates/  app.ts  cdk.json  infra-package.json  workflows/
├── packages/cdk-core/  src/{index,site,preview-site,preview-deployment,github-deploy-role,
│                            certificate,define-site-stacks}.ts
│                       src/router/  src/handlers/  src/auth/{browser,server}.ts  src/bin/sweep.ts  dist/
├── apps/web/  apps/api/  e2e/  infra/bin/app.ts  scripts/  docs/{prior-art.md,research/,spikes/}
│                       e2e/ is a workspace package: playwright.config.ts + *.spec.ts at its root
│                       infra/bin/app.ts is GENERATED from the new-site template; edit both
└── .github/workflows/  ci.yml  deploy.yml  pr-preview.yml  pr-teardown.yml  cleanup.yml
```

`.claude/rules/` is seven files: `cdk.md` (stacks, the router), `cloudfront-origins.md` (OAC,
the invoke permissions, the POST payload hash, the delete order), `plugin.md` (the marketplace,
the skills, the templates), `auth.md`, `streaming-and-kvs.md`, `testing.md`,
`typescript-config.md`.

## Risks and open questions

Ordered by how much of the plan they can invalidate. Each has an owner epoch.

1. ~~**OAC on a dynamically selected Lambda URL origin**~~ (D1). **[revised, Epoch 2] Closed —
   it works.** Proven by hand in the Epoch 2 spike and then in production shape; neither the
   secret-header fallback nor yahn's per-PR distribution is needed.
2. ~~**KVS ETag mismatch error code** is inferred~~ (D2). **[revised, Epoch 2] Closed — it is
   `ValidationException: Pre-Condition failed`.** The handler still retries on both candidates.
   A new hazard took its place and is also closed: the bundled handler must import
   `@aws-sdk/signature-v4a` or every KVS call fails.
3. **KVS propagation delay** has no SLA (D2). `pr-preview.yml` polls up to 5 min. **[revised,
   Epoch 3] The poll exists and is green**, but has never actually had to wait long: many
   preview deploys answered `/api/ping` on the first or an early attempt. **[revised, Epoch 5]
   The *delete* side is now measured, and it is the visible one.** After `CdkCore-pr-9`'s stack
   delete finished, `verify-preview.sh 9 --expect-absent` reported 3 of 7 checks passing and was
   7 of 7 under a minute later; while the delete was still running it was 1 of 7. The residual
   answer is **403 on `/api/*` as well**, which is `CACHING_DISABLED` — so this is not the edge
   caching Epoch 4's handoff attributed it to. It is edges that still resolve a key `list-keys`
   already reports gone, rewriting to a `/pr-<n>/` prefix whose objects are deleted, and getting
   S3's `AccessDenied`. The create side remains unmeasured because it has never had to wait.
4. ~~**URI-rewrite cache keys**~~ (D10). **[revised, Epoch 2] Closed — proven before anything
   depended on it**, with query strings excluded from the cache policy so the rewritten URI was
   the only differentiator.
5. ~~**Lite vs Essentials for social IdPs** doc conflict (D4)~~ — moot, Essentials chosen.
   **[revised, Epoch 4] Closed**: the classic hosted UI with `identity_provider=Google` on an
   Essentials pool signs a real user in, on both pools.
6. ~~**`state` size** is undocumented~~; ours is ~30 chars. **[revised, Epoch 4] Closed** — a
   `<nonce>.<pr>` state round-trips through Cognito, Google and the bounce unchanged.
7. **Preview e2e flakiness on cold Lambdas** — Playwright `expect.timeout` 15 s, and the
   `/api/ping` poll warms the API Lambda before the suite. **[revised, Epoch 4] The *vitest*
   side bit instead**: `Template.fromStack` stages and zips every `Code.fromAsset`, and on a
   two-core CI runner that exceeded vitest's 5 s default. `testTimeout` is 30 s as a hang
   guard.
11. **[Epoch 4] The refresh path has never refreshed a real token.** Unit-tested against a fake
    endpoint; the window is 5 minutes against a 1-hour token, so no run has reached it.
12. **[Epoch 4] `logout()` is local-only** — it clears `localStorage` and does not call
    Cognito's `/logout`, so the pool and Google sessions survive. Fine for this reference site;
    a consumer wanting a real sign-out needs the hosted-UI logout redirect.
8. **Custom domains capped at 4/Region** (D4) — only if a site opts into `auth.<site>`.
9. **`claude -p "/skill"`** undocumented (D8) — only affects the optional unattended loop.
10. **Google consent screen in Testing** limits to 100 test users; publishing requires no
    review for basic scopes (unverified) — irrelevant until a site has real users.
