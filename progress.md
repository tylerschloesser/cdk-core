# Progress log

One entry per epoch (or per stop), newest last. Heading format is fixed — `/epoch` tails it:

`## Epoch <n> — <title> — <YYYY-MM-DD> — <DONE | PARTIAL | BLOCKED>`

## Epoch 0 — Plan and session mechanism — 2026-09-06 — DONE

**Shipped.** `plan.md` (decisions D1–D11, construct API, Epochs 1–6, acceptance criteria,
cost guardrails, delegation plan, session mechanism), `docs/prior-art.md` (thai vs yahn),
`docs/research/{cloudfront-kvs-sse,cognito-google-auth,claude-code-primitives}.md` (cited
research, 2026-09-06), `CLAUDE.md`, `.claude/skills/{epoch,handoff}`,
`.claude/agents/{implementer,verifier}`, `.claude/settings.json`, `.gitignore`, `README.md`.

**Acceptance test.** In a fresh session, `/epoch 1` prints the Status block, this entry, and
the Epoch 1 section. (Checked by running the skill's `awk` extraction by hand; see below.)

**Deviations from the plan.** None — this is the plan. Two things the prompt assumed that
research overturned, recorded in `plan.md`: Google's redirect-URI exact match is not the
constraint on per-PR callbacks (Google only sees the Cognito pool domain; Cognito's own
callback list is), and CloudFront Functions have had origin selection since 2024-11 so
Lambda@Edge is not needed.

**Left undone / untested.** The `/epoch` skill's `` !`awk` `` extraction was verified from a
shell, not from inside a Claude session. Whether `claude -p "/epoch n"` works headlessly is
unverified and optional.

**AWS resources alive after this epoch.** None. No GitHub repo yet either (Epoch 1 creates it).

**What the next epoch needs to know.**
- Read `plan.md` → Construct API before scaffolding `packages/cdk-core`; the `exports` map
  and prop names are the contract every later epoch builds on.
- The reference app deliberately has *two* backends (`api` buffered, `events` streaming) so
  the multi-backend path is exercised from day one.
- `thai.ler.dev` and `yahn.ty.ler.dev` on this machine are the style reference (pnpm catalog,
  oxlint config, tsconfig base, Playwright config). Copy conventions, not code.
- The npm name is `@tylerschloesser/cdk-core`; nothing is published until Epoch 5.

## Epoch 1 — Monorepo, reference app, local dev, local e2e, CI — 2026-09-06 — DONE

**Shipped.** Commits `7b64a5a..6c2b3c3` on `epoch-1-monorepo`, PR
[#1](https://github.com/tylerschloesser/cdk-core/pull/1). The GitHub repo
`tylerschloesser/cdk-core` now exists (public, no branch protection).

- `pnpm-workspace.yaml` (globs `apps/*`, `e2e`, `infra`, `packages/*`; `catalog:` block),
  root `package.json` scripts `dev build typecheck lint test e2e verify`, `tsconfig.base.json`,
  `.oxlintrc.json`, `esbuild` as a root devDependency.
- `packages/cdk-core`: `src/index.ts` — the whole Construct API as interfaces with throwing
  constructors (`Site`, `PreviewSite`, `PreviewDeployment`, `GithubDeployRole`,
  `siteCertificate`); `src/config.ts` (`SiteConfig`, `CONFIG_PATH`, `AUTH_STORAGE_KEY`,
  `ID_TOKEN_HEADER`); `src/sse.ts` (`readSse`); `src/hash.ts` (`sha256Hex`,
  `EMPTY_BODY_SHA256`); `src/auth/browser.ts` (local mode real, Cognito throws Epoch 4);
  `src/auth/server.ts` (`authMode`, `getUser`, `parseDevToken`; `createVerifier` throws);
  `src/bin/sweep.ts` stub. 16 vitest tests in `test/`.
- `apps/api`: `src/app.ts` (`/api/ping`, `/api/echo`, `/api/me`), `src/events.ts`
  (`/events/tick`, `: keepalive` every 10 s, `id:` per event), `src/server.ts` (:3001/:3002),
  `src/lambda-api.ts`, `src/lambda-events.ts`.
- `apps/web`: Vite + React 19, `src/App.tsx` (`/` and `/auth/callback`, no router library),
  `vite.config.ts` with the `/api` + `/events` proxies and an inline plugin serving
  `/__config.json` in both dev and preview.
- `e2e`: `playwright.config.ts` (one config, two targets), `smoke.spec.ts`, `api.spec.ts`,
  `sse.spec.ts`, `auth.spec.ts` — 7 tests.
- `.github/workflows/ci.yml`; `.claude/rules/typescript-config.md`, `.claude/rules/testing.md`;
  `README.md` rewritten.

**Acceptance test.** All three parts pass, run from a clean tree at `6c2b3c3`:

```
$ pnpm install && pnpm verify && pnpm e2e
  7 passed (5.4s)
$ ( pnpm dev & ) ; t0=...; until curl -fsS localhost:5173 && curl -fsS localhost:3001/api/ping | grep -q pong; ...
dev up in 2s
```

CI green on PR #1: run `34056658137`, `verify in 1m14s`, `7 passed (7.5s)`.

Measured separately, 7 interleaved cold/warm samples (order alternated per pair), `pnpm dev`
to a 200 from both `:5173` and `/api/ping`:

| | median | range |
| --- | --- | --- |
| warm (`dist/` and `.tsbuildinfo` present) | **1.14 s** | 0.91–1.15 |
| cold (`packages/cdk-core/dist` + `node_modules/.tmp` wiped) | **2.85 s** | 2.63–3.70 |

Budget was 10 s (A4). `node_modules` present in both; `pnpm install` is not in the number.

**Deviations from the plan.**

1. **`packages/cdk-core` is consumed as built `dist/`, not as source.** `thai.ler.dev`'s
   workspace packages are imported as TypeScript through their exports map; this one cannot
   be, because the exports map is the contract an npm consumer resolves in Epoch 5. Three
   consequences, all now in `.claude/rules/typescript-config.md`: internal relative imports
   inside `src/` carry **`.js`** specifiers (`.ts` fails under `nodenext` in an emitting
   project); `apps/*` carry a project reference to the package and import it by package
   specifier; root `dev` is `pnpm --filter @tylerschloesser/cdk-core run build && pnpm -r
   --parallel run dev` so `dist/` exists before Vite and tsx start.
2. **`e2e`'s script is `e2e`, not `test`.** With it named `test`, `pnpm -r run test` (inside
   `pnpm verify`) ran the whole Playwright suite — duplicating `pnpm e2e` and making `verify`
   need browsers. Root `e2e` is `pnpm --filter e2e run e2e`. Both `pnpm e2e smoke.spec.ts` and
   the plan's `pnpm e2e e2e/smoke.spec.ts` work (Playwright filters on substring).
3. **Playwright browsers install through the package**:
   `pnpm --filter e2e exec playwright install chromium`. `@playwright/test` is a dependency of
   `e2e`, not of the root, so a bare `pnpm exec playwright` fails with "Command not found".
   CI run `34056594873` failed on exactly this; fixed in `6c2b3c3`.
4. **`packages/cdk-core/tsconfig.test.json` needs its own `tsBuildInfoFile`.**
   `tsconfig.base.json` derives one from `${configDir}`, which is the same directory for the
   build and test projects, and two projects cannot share one (TS6377).
5. **`apps/web` uses `module: "preserve"` + `moduleResolution: "bundler"`.** TypeScript 6 has
   no `"bundler"` value for `--module` (TS6046).
6. **`auth/server` types Hono's context structurally** (`RequestLike`, an object with
   `req.header(name)`) instead of importing `hono`, so the package has no runtime dependency
   on a consumer's web framework or its major version. `aws-cdk-lib`/`constructs` are
   **optional** peer dependencies for the same reason: `auth/browser` should not require CDK.
7. **Additions not in the plan, all small**: `/events/tick` takes `intervalMs` as well as `n`,
   so Epoch 2/6 can re-measure CloudFront's SSE behavior against a live distribution without a
   redeploy; `apps/web` links `src/app.css` from `index.html` rather than a TS side-effect
   import (which would need `vite/client` ambient types); `login()` takes an optional
   `devUser`; `readSse` yields `id` when the frame carries one.
8. **CI pins yahn's proven action versions** (`actions/checkout@v7`, `actions/setup-node@v7`,
   `pnpm/action-setup@v6`) on node 22, not yahn's 24, to match `engines` and this machine.
9. `catalog:` gained `vitest ^5.0.0` (latest; pairs with vite 8). TypeScript is `~6.0.2` and
   oxlint `^1.81.0`, both copied from thai.

**Left undone / untested.**

- The e2e suite has **never been run against a non-local target**. `PLAYWRIGHT_BASE_URL` is
  wired and the specs carry no localhost assumptions, but nothing is deployed until Epoch 2.
  `auth.spec.ts`'s dev-login tests are `test.skip`ped when `PLAYWRIGHT_BASE_URL` is set —
  Epoch 4 replaces that skip with a machine-auth fixture rather than deleting the tests.
- `src/lambda-api.ts` and `src/lambda-events.ts` are never loaded by anything yet (no
  `awslambda` global outside Lambda). They typecheck; that is all that is proven.
- `infra` is in the workspace globs but the directory does not exist. pnpm tolerates it.
- The `.` export (`aws-cdk-lib` types) is typechecked but never synthesized — every construct
  throws, so nothing has proven the props actually compose in a real stack. Epoch 2 does that.

**AWS resources alive after this epoch.** None. Nothing in this epoch touched AWS, and
`pnpm verify`, `pnpm dev` and `pnpm e2e` all run with no credentials.

**What the next epoch needs to know.**

- **The repo is public** and `plan.md`/`CLAUDE.md` contain the AWS account id `063257577013`
  and both hosted-zone ids. That is what the plan specified (`--public`), and an account id is
  not a credential, but it is now world-readable — worth a deliberate confirm from the user
  before more account detail lands in tracked files.
- Run `pnpm --filter e2e exec playwright install chromium` once in a fresh clone, or `pnpm e2e`
  fails with a missing-browser error rather than a test failure.
- `pnpm dev` builds the package first, then watches. If you see a stale type from
  `@tylerschloesser/cdk-core`, the fix is `rm -rf packages/cdk-core/node_modules/.tmp` — a
  stale `.tsbuildinfo` makes `tsc -b` skip work it should do.
- The **`backends` keys are the contract** between the three constructs (`api`, `events` in the
  reference). `apps/web` calls `/api/*` and `/events/*` same-origin everywhere; Vite proxies
  locally, CloudFront routes by behavior in prod and previews. Do not add a third path prefix
  without adding it to all three.
- `/api/echo` is a POST **with a body** on purpose, and `apiFetch` sends
  `x-amz-content-sha256` for it. That is the path that 403s under OAC if the hash is wrong, and
  `e2e/api.spec.ts` is what catches it — run that spec against the first preview in Epoch 2.
- `e2e/sse.spec.ts` asserts inter-arrival timing (1st→5th ≥ 400 ms, 1st→2nd ≤ 1500 ms) read
  from `data-received-at`, which `apps/web` stamps when `readSse` yields each frame. This is
  the assertion that will fail if CloudFront buffers, compresses, or the function URL is not
  `RESPONSE_STREAM`. If you change `/events/tick`'s default interval, change both bounds in
  the same commit.
- PR #1 is **merged** into `main`; `main` is the base for Epoch 2's branch.

## Epoch 2 — Preview topology: `PreviewSite`, `PreviewDeployment`, the routing spike — 2026-09-06 — DONE

Commits `4cee88d..b1037d0`, merged to `main` as **PR #2** (merge commit `ccf576d`); the branch
is deleted. CI run `34063308975` green: `verify` plus `7 passed (9.4s)`.

### Shipped

**The spike came first, and it retired the plan's #1 risk.**
`docs/spikes/2026-09-06-oac-routing-spike.md` records a throwaway distribution built by hand
(KVS + JS 2.0 function + `RESPONSE_STREAM` function URL + S3, all named `cdk-core-spike-*`,
all deleted). It settled both undocumented claims the design rests on:

- **D1 holds.** An inline `originAccessControlConfig{originType:'lambda'}` on
  `cf.updateRequestOrigin()` correctly SigV4-signs a request to an `AWS_IAM` function URL that
  is **not** an origin of the distribution. `curl -N` showed 5 SSE events at 0/438/939/1440/1941 ms.
  A POST with a body returned 200 with `x-amz-content-sha256` and **403** without it or with a
  wrong one. The `AuthType: NONE` + secret-header fallback is not needed.
- **D10 holds.** Two `pr-<n>/` prefixes, the same viewer path `/`, different bodies, both
  `x-cache: Hit from cloudfront`, no cross-contamination — with query strings excluded from the
  cache policy, so the rewritten URI was the only differentiator. One shared preview bucket is
  safe; no per-PR bucket, no `originPath`.

**Constructs** (`packages/cdk-core/src/`), split out of `index.ts` into the layout `plan.md`
targets — `types.ts`, `certificate.ts`, `preview-site.ts`, `preview-deployment.ts`,
`router/render.ts`, `handlers/preview-resources.ts`:

- `siteCertificate` — `<domain>` + `*.preview.<domain>`, DNS-validated, with a synth-time
  us-east-1 check.
- `PreviewSite` — shared bucket (`DESTROY` + `autoDeleteObjects`), `KeyValueStore`, the router
  function, the distribution with the `*.preview.<domain>` alias, wildcard A/AAAA, and four SSM
  parameters (`distributionArn`, `distributionId`, `bucketName`, `kvsArn`). `auth` is accepted
  and warns via `addWarningV2`.
- `PreviewDeployment` — one `BucketDeployment` to `pr-<n>/` with `__config.json` from
  `Source.jsonData`, both `CfnPermission`s per backend, the `KvsRoute` custom resource, and
  `cdk-core:pr` tags on the whole stack. Reads SSM; takes no construct reference to `PreviewSite`.
- `renderRouterSource()` — 3842 bytes for the reference config, `ComputeUtilization` **7**
  measured on the deployed function.
- The `KvsRoute` handler — bundled CJS at `dist/handlers/preview-resources/index.js` (1.1 MB,
  SDK included), describe→`UpdateKeys` retried as a unit with 100–500 ms jitter, ≤ 10 attempts.

**`infra/`** — `bin/app.ts` with `CdkCoreShared`, `CdkCorePreview` and a context-gated
`CdkCore-pr-<n>`; two `NodejsFunction`s (`NODEJS_22_X`, arm64, `externalModules: ['@aws-sdk/*']`),
the events URL `RESPONSE_STREAM`.

**`scripts/verify-preview.sh <n> [--domain d] [--expect-absent]`** — 7 checks, no AWS
credentials, pure curl + python3.

**Tests** — 48 vitest (up from 16): the retry loop against a fake client, the renderer's
validation and size, and **seven that execute the generated router source** with `cf` injected.

### Acceptance test

Run in order, exactly as `plan.md` § Epoch 2 states it.

```
$ pnpm build && cdk deploy CdkCoreShared CdkCorePreview --require-approval never
✅  CdkCoreShared     (certificate DNS validation ~90 s)
✅  CdkCorePreview

$ cdk deploy CdkCore-pr-1 -c pr=1 --require-approval never          # timed
✨  Deployment time: 86.34s
=== CdkCore-pr-1 FIRST DEPLOY: 102s ===                              # target ≤ 180 s

$ scripts/verify-preview.sh 1
PASS assets (GET /)               200, text/html, <div id="root"> present
PASS SPA fallback (GET /some/deep/path) 200, falls back to index.html
PASS config (GET /__config.json)  200, valid JSON, mode=preview, pr=1
PASS buffered API (GET /api/ping) 200, body contains "pong"
PASS signed POST (POST /api/echo) 200, body reports length 13
PASS SSE stream (GET /events/tick?n=5) 5 tick frames; 1st->5th spread 2004ms (>=400), 1st->2nd gap 500ms (<=1500)
PASS unknown host (GET pr-999999.preview.cdk-core.ty.ler.dev) 404 as expected
7 passed, 0 failed

$ aws cloudformation delete-stack --stack-name CdkCore-pr-1 && aws cloudformation wait stack-delete-complete ...
=== teardown: 62s ===

$ scripts/verify-preview.sh 1 --expect-absent
7 passed, 0 failed          # every check now 404s

$ aws cloudfront-keyvaluestore list-keys --kvs-arn "$(aws ssm get-parameter --name /cdk-core/cdk-core.ty.ler.dev/preview/kvsArn ...)"
{ "Items": [] }

$ aws s3 ls s3://cdkcorepreview-previewassets8b9f2052-z0r9uodmnime/pr-1/
(empty)
```

Two things beyond what the plan asked for:

- **The Playwright suite ran against a non-local target for the first time.**
  `PLAYWRIGHT_BASE_URL=https://pr-1.preview.cdk-core.ty.ler.dev pnpm e2e` → `5 passed, 2 skipped`
  (the two skips are the dev-login tests Epoch 1 gated on `PLAYWRIGHT_BASE_URL`; Epoch 4
  replaces the skip with a machine-auth fixture). The identical specs pass locally: `7 passed`.
- **Repeat deploy times**, three consecutive `cdk deploy CdkCore-pr-1 -c pr=1 --exclusively`
  with no source change: **32 s, 33 s, 33 s**. The `deployedAt` field makes the `KvsRoute`
  resource update every time, so this is the real repeat cost, not a no-op diff.

`pnpm verify` and `pnpm e2e` both green at `b7d1521`.

### Deviations from the plan

1. **`await` may not appear inside a call's argument list in `cloudfront-js-2.0`.**
   `JSON.parse(await kvs.get(k))` — the obvious way to write it, and what the first spike
   function did — fails to publish with `SyntaxError: await in arguments not supported`. It is
   a *syntax* error, so the function never runs and every request through the distribution
   returns `503 The CloudFront function ... is invalid or could not run` with no detail at the
   edge. `aws cloudfront test-function` is the only thing that prints the real message.
   `test/router.test.ts` now asserts the generated source never does this.
2. **Both `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction` are required** — measured in
   both directions with the baseline re-confirmed afterwards, 20–30 s between each transition:
   `InvokeFunctionUrl` only → **403**, `InvokeFunction` only → **403**, both → **200**. The plan
   said to grant both (carried from yahn); this is the measurement behind it.
3. **The bundled KVS handler must import `@aws-sdk/signature-v4a` for its side effect.**
   This is D2's SigV4A hazard in concrete form and it broke the first PR-stack deploy: the KVS
   data-plane endpoint is global, so the client signs with SigV4A, and the SDK ships no SigV4A
   implementation — it looks one up in a registry a separate package populates on import.
   Bundled, that lookup finds nothing and every call dies at `describe` with
   `Neither CRT nor JS SigV4a implementation is available`. The import is documented at the
   import site as load-bearing so nobody removes it as unused.
4. **SPA fallback serves the shell; it must not append `index.html`.** The renderer's first
   version turned `/auth/callback` into `pr-1/auth/callback/index.html`, and every deep client
   route came back **403** — not 404, because an OAC bucket policy grants `s3:GetObject` and
   not `s3:ListBucket`, so S3 answers a missing key `AccessDenied`. Caught by check 2 of
   `verify-preview.sh` on the first run against a live preview. Epoch 4 would have hit it on
   its first Google login. It passed every substring assertion in the renderer's tests, which
   is why those tests now **execute** the generated source.
5. **A KVS cannot be associated with a function until it reports `READY`** (~35 s to
   provision); `CreateFunction` against a `PROVISIONING` store fails with `InvalidArgument`.
   The CDK L2 orders this correctly — it only bites a CLI or custom-resource path.
6. **`origin-placeholder.invalid` is accepted as an origin domain name.** CloudFront does no
   resolvability check at `CreateDistribution`. Backend behaviors are assigned it so that a
   router which somehow fails to override the origin fails loudly rather than quietly reaching
   a real host.
7. **One `BucketDeployment`, not two.** The plan's deliverable implies the prod split (hashed
   assets immutable, unversioned `no-cache`). Previews get a single deployment with
   `public, max-age=0, must-revalidate` on everything plus `distributionPaths: ['/pr-<n>/*']`.
   Two deployments with the same prefix and `prune: true` fight over each other's files, and a
   second custom-resource invocation sits on the critical path of every push for a caching win
   that a short-lived preview does not collect. `Site` (Epoch 3) still needs the real split.
8. **The KVS value carries a synth-time `deployedAt`**, so the custom resource updates on
   every deploy and re-puts the key. That is deliberate: a preview whose key was swept or
   hand-deleted heals on the next push instead of staying dark. It costs ~2 s per deploy and
   makes `cdk diff` on a PR stack always non-empty.
9. **Two KVS data-plane facts D2 had only inferred, now measured**: deleting a key that does
   not exist **succeeds** (same ETag back, `ItemCount` unchanged), and a stale ETag returns
   **`ValidationException: Pre-Condition failed during update of Key-Value-Store`**, not
   `ConflictException`. The handler retries on both regardless, since the mapping is
   undocumented.
10. **`infra/cdk.json` carries no `context` block.** The scaffold's
    `@aws-cdk/core:enableStackNameDuplicates` is a CDKv1 flag and CDKv2 throws
    `UnsupportedFeatureFlag` on it at synth.

### Left undone / untested

- **The bounce host (`oauth.preview.cdk-core.ty.ler.dev`) is only unit-tested and
  `test-function`-tested**, never driven by a browser — there is no auth to bounce yet. Its
  302 and both its refusal paths (malformed `state`, PR with no KVS key) are covered by the
  executed-source tests and were confirmed against the deployed function with
  `aws cloudfront test-function`.
- **Nothing has raced two PR deploys**, so the retry loop has only ever been exercised against
  a fake client and a single-writer live store. Epoch 6 owns that.
- **`Site`, `GithubDeployRole` and every `auth` prop still throw or warn.** `PreviewSite` emits
  `@tylerschloesser/cdk-core:previewAuthNotImplemented` if handed `auth`.
- **No CI workflow deploys anything yet.** Every deploy this epoch was from this machine with
  `AWS_PROFILE=admin`. Epoch 3 owns the OIDC role and the three workflows.
- `unversioned` on `PreviewDeploymentProps` is accepted and ignored (see deviation 7).

### AWS resources alive after this epoch

`CdkCoreShared` (one ACM certificate) and `CdkCorePreview` (distribution `E3DN700ELXRXMT`,
bucket `cdkcorepreview-previewassets8b9f2052-z0r9uodmnime`, KVS
`c23e3678-4dea-4cf8-b6d2-1aa0b8e1f364`, the router function, two wildcard DNS records, four SSM
parameters). Idle cost ≈ $0. **No PR stack is alive**; `CdkCore-pr-1` was created, verified and
deleted, and the KVS and the `pr-1/` prefix were both confirmed empty afterwards.

To remove everything this epoch created:

```
AWS_PROFILE=admin pnpm --filter infra exec cdk destroy CdkCorePreview CdkCoreShared
```

To remove a leaked PR stack (only ever a name read back from `list-stacks`):

```
AWS_PROFILE=admin aws cloudformation delete-stack --region us-east-1 --stack-name CdkCore-pr-<n>
AWS_PROFILE=admin aws cloudformation wait stack-delete-complete --region us-east-1 --stack-name CdkCore-pr-<n>
```

### What the next epoch needs to know

- **`.claude/rules/cdk.md` is the file to read before touching any of this.** It carries all
  eleven gotchas with their measurements; this entry is the narrative, that file is the
  reference.
- **`pnpm build` must run before any `cdk` command**, including `destroy`. `PreviewDeployment`
  reads `apps/web/dist` and `Code.fromAsset` reads `packages/cdk-core/dist/handlers/`, so a CDK
  command against a clean tree fails on a missing directory. Teardown synthesizes too.
- **Deploy times to budget against A1** (from this machine, not CI): `CdkCore-pr-<n>` first
  create **102 s**, repeat **32–33 s**, teardown **62 s**, `CdkCorePreview` update **71 s**,
  `CdkCoreShared` create ~**90 s** (certificate DNS validation). CI adds checkout, install and
  build on top; the plan's 5 min first / 3 min repeat looks comfortable.
- **Changing the router means redeploying `CdkCorePreview`, not the PR stack.** The function
  is owned by `PreviewSite`. Allow ~45 s for the stack plus ~30–60 s of edge propagation before
  a `curl` reflects the change.
- **`scripts/verify-preview.sh <n> --expect-absent` is the teardown check**, and it is a
  first-class mode rather than a comment — Epoch 3's `pr-teardown.yml` and the sweeper's
  acceptance test should both call it.
- **Do not add a third path prefix without adding it in four places**: `PreviewSite.backends`,
  `PreviewDeployment.backends`, `apps/web`'s fetches, and Vite's dev proxy. The router cannot
  change which cache behavior CloudFront selected, so the viewer's path must already
  distinguish them.
- **Epoch 3's `Site` needs the two-`BucketDeployment` split** that previews deliberately skip
  (deviation 7), and it should share `PreviewSite`'s backend-behavior factory — the
  `CACHING_DISABLED` + `ALL_VIEWER_EXCEPT_HOST_HEADER` + `compress: false` + both-`CfnPermission`s
  shape is identical.
- **The sweeper's anchor is `^CdkCore-pr-[0-9]+$`**, and `infra/bin/app.ts` validates the `pr`
  context against `/^[0-9]+$/` so the stack name cannot be forged from context.
- The repo is still **public**, and `plan.md`, `CLAUDE.md` and now `.claude/rules/cdk.md` and
  `docs/spikes/` carry the account id, both zone ids, and the preview distribution/bucket/KVS
  ids. Still not credentials, still world-readable — the confirm asked for after Epoch 1 is
  still outstanding.
- No new human action is owed for Epoch 3 beyond `aws sso login --profile admin`. Epoch 4 needs
  the Google OAuth client; Epoch 5 needs `npm login`.
- PR #2 is **merged** into `main`; `main` is the base for Epoch 3's branch.

## Epoch 3 — `Site` (prod), `GithubDeployRole`, the three workflows, the sweeper — 2026-09-06 — DONE

`https://cdk-core.ty.ler.dev` is live and deployed by `deploy.yml`. Every PR on this repo gets
a preview, its e2e runs against it, closing it tears it down, and the sweeper finds nothing
left. Still no auth.

Commits `ebc7cb5..` (PR #3, squashed and merged) plus `c47cefd`, `14c39cc`, `6df1e23` on the
handoff branch.

### Shipped

- **`Site`** (`packages/cdk-core/src/site.ts`): prod bucket (OAC, `DESTROY` + `autoDeleteObjects`
  — it holds only build output), distribution with the SPA-fallback function on the default
  behavior, one behavior per backend on a real `FunctionUrlOrigin.withOriginAccessControl`, the
  explicit second `lambda:InvokeFunction` grant per backend, apex A + AAAA, and the
  **two-`BucketDeployment` split** previews skip: hashed assets `public, max-age=31536000,
  immutable` + `prune: true`, then the unversioned globs (`*.html`, `sw.js`,
  `manifest.webmanifest`, `registerSW.js`, `__config.json`) `no-cache`, `prune: false`, with a
  `/*` invalidation and an explicit dependency on the first.
- **What `Site` and `PreviewSite` share is now code, not convention.**
  `src/behaviors.ts` `backendBehavior()` builds every backend behavior for both;
  `src/behaviors.ts` `safeDistributionOverrides()` strips the four props `distributionOverrides`
  may not replace (which is what makes that prop's doc comment true — it was not before);
  `src/router/spa.ts` `renderSpaSource()` renders prod's fallback with the router's rule;
  `src/backend.ts` `backendReadTimeoutSeconds()` derives the timeout for both.
  **Proof the refactor is a no-op: `cdk synth CdkCorePreview` is byte-identical before and
  after** (`diff` on the two `CdkCorePreview.template.json`).
- **`CachePolicies.originDecides(scope)`** (`src/cache-policies.ts`), carried from yahn:
  `minTtl/defaultTtl 0`, `maxTtl 5 min`, query strings in the key, no headers, no cookies.
- **`GithubDeployRole`** (`src/github-deploy-role.ts`): imports the account's OIDC provider,
  trusts both `sub` forms × both `ref:refs/heads/main` and `pull_request`, and grants
  `sts:AssumeRole` on the bootstrap roles, `cloudformation:ListStacks` on `*`,
  `DescribeStacks`/`DeleteStack` on `stack/CdkCore-pr-*`, `ssm:GetParameter(s)` on the preview
  prefix, the four KVS actions on the KVS ARN, and `s3:ListBucket`/`DeleteObject` on the
  preview bucket.
- **`cdk-core sweep`** (`src/sweep/reconcile.ts` pure + `src/sweep/aws.ts` I/O +
  `src/bin/sweep.ts` CLI), with `--dry-run`, 12 vitest cases against fakes.
- **Five workflows** in `.github/workflows/`: `deploy.yml`, `pr-preview.yml`, `pr-teardown.yml`,
  `cleanup.yml` (plus Epoch 1's `ci.yml`). All `cancel-in-progress: false`; teardown shares
  pr-preview's concurrency group.
- **Workflow templates** in `plugins/cdk-core/skills/new-site/templates/`, with
  `test/workflow-templates.test.ts` asserting each renders **byte-identical** to the real
  workflow after substituting `{{SITE_DOMAIN}}`, `{{STACK_PREFIX}}`, `{{PACKAGE_NAME}}`.
- **README `## Deploying`** section, and a status paragraph that is true again.
- 94 vitest cases across 9 files; `pnpm verify` and `actionlint .github/workflows/*.yml` green.

### Acceptance test

Run as written in the plan, in this order.

```
AWS_PROFILE=admin pnpm --filter infra exec cdk deploy CdkCoreGithubOidc --require-approval never
  -> CdkCoreGithubOidc.DeployRoleRoleArn = arn:aws:iam::063257577013:role/cdk-core-github-deploy
     Deployment time: 43.92s
gh variable set AWS_DEPLOY_ROLE_ARN --body arn:aws:iam::063257577013:role/cdk-core-github-deploy
  -> AWS_DEPLOY_ROLE_ARN  arn:aws:iam::063257577013:role/cdk-core-github-deploy

AWS_PROFILE=admin pnpm --filter infra exec cdk deploy CdkCoreSite --require-approval never
  -> CdkCoreSite.SiteUrl = https://cdk-core.ty.ler.dev    Deployment time: 223.8s (240 s wall)
curl https://cdk-core.ty.ler.dev/api/ping          -> {"message":"pong"}
curl https://cdk-core.ty.ler.dev/__config.json     -> {"site":"cdk-core.ty.ler.dev","mode":"prod"}
curl -o/dev/null -w%{http_code} .../auth/callback  -> 200   (SPA fallback serves the shell)
curl -o/dev/null -w%{http_code} .../assets/nope.js -> 403   (a missing *asset* still fails)
curl -I .../                                       -> cache-control: no-cache
curl -I .../assets/index-2lZu2ZaV.js               -> cache-control: public, max-age=31536000, immutable
PLAYWRIGHT_BASE_URL=https://cdk-core.ty.ler.dev pnpm e2e   -> 5 passed, 2 skipped

gh pr create (#3) ; gh run watch
  -> CI success; PR Preview success, comment: "✅ deployed and e2e passed ... deploy 95 s ·
     push → comment 149 s"
scripts/verify-preview.sh 3                        -> 7 passed, 0 failed
PLAYWRIGHT_BASE_URL=https://pr-3.preview.cdk-core.ty.ler.dev pnpm e2e -> 5 passed, 2 skipped

gh workflow run deploy.yml (and the push-to-main run)
  -> Deploy [push] success 148 s; Deploy [workflow_dispatch] success 103 s.
     Both ran verify, local e2e, `cdk deploy CdkCoreShared CdkCorePreview CdkCoreSite`,
     the /api/ping poll, and e2e against production.

git commit --allow-empty && git push  (throwaway PR #4, then closed not merged)
  -> PR Preview success, comment: "deploy 93 s · push → comment 165 s"
scripts/verify-preview.sh 4                        -> 7 passed, 0 failed
gh pr close 4 ; gh run watch
  -> PR Teardown success in 14 s
aws cloudformation wait stack-delete-complete --stack-name CdkCore-pr-4
  -> returned 86 s after `gh pr close`
scripts/verify-preview.sh 4 --expect-absent        -> 7 passed, 0 failed (every check 404s)

AWS_PROFILE=admin pnpm --filter infra exec cdk-core sweep --site cdk-core.ty.ler.dev \
  --stack-prefix CdkCore --repo tylerschloesser/cdk-core --dry-run
  -> (nothing to reconcile)        exit 0
aws cloudfront-keyvaluestore list-keys --kvs-arn <kvs>  -> {"Items": []}
aws s3 ls s3://cdkcorepreview-previewassets8b9f2052-z0r9uodmnime/  -> empty
```

**Timings against A1** (four preview deploys, not a randomized study — the target has ~2x
headroom, so more sampling was not warranted; each number is one observation):

| | deploy step | job start → comment | real `git push` → comment |
| --- | --- | --- | --- |
| PR #3, new stack | 95 s | 149 s | — (triggered by `pr create`) |
| PR #3, empty commit | **29 s** | 80 s | **88 s** |
| PR #3, third push | 33 s | 100 s | — |
| PR #4, new stack | 93 s | 165 s | — |

Target: ≤ 5 min first deploy, ≤ 3 min repeat. Both met with room. Teardown workflow 14 s
against a ≤ 2 min target; the stack is fully gone 86 s after the close.

The IAM scope check the plan asked for, `aws iam simulate-principal-policy` on the new role:

| Resource | `cloudformation:DeleteStack` |
| --- | --- |
| `stack/YahnAppStack-prod/*` | **implicitDeny** |
| `stack/ThaiLerDevSiteStack/*` | **implicitDeny** |
| `stack/CDKToolkit/*` | **implicitDeny** |
| `stack/CdkCoreSite/*` | **implicitDeny** |
| `stack/CdkCore-pr-7/*` | allowed |

The **$10/month budget**, created by hand (there were none in the account before):

```
aws budgets create-budget --account-id 063257577013 --region us-east-1 \
  --budget '{"BudgetName":"account-monthly-10-usd","BudgetLimit":{"Amount":"10","Unit":"USD"},"TimeUnit":"MONTHLY","BudgetType":"COST"}' \
  --notifications-with-subscribers '[{"Notification":{"NotificationType":"ACTUAL","ComparisonOperator":"GREATER_THAN","Threshold":80,"ThresholdType":"PERCENTAGE"},"Subscribers":[{"SubscriptionType":"EMAIL","Address":"tyler.schloesser+aws-user@gmail.com"}]},{"Notification":{"NotificationType":"FORECASTED","ComparisonOperator":"GREATER_THAN","Threshold":100,"ThresholdType":"PERCENTAGE"},"Subscribers":[{"SubscriptionType":"EMAIL","Address":"tyler.schloesser+aws-user@gmail.com"}]}]'
```

The last acceptance line, `gh workflow run cleanup.yml`, could only run after the handoff
branch merged: its first run failed (`Command "cdk-core" not found`, fixed by `14c39cc` — see
deviation 4), and the fixed version cannot be dispatched from a branch, because the deploy
role's trust allows `ref:refs/heads/main` and `pull_request` and nothing else, so
`gh workflow run cleanup.yml --ref epoch-3-handoff` is refused at
`sts:AssumeRoleWithWebIdentity` — correct behaviour, not a bug. Dispatched from `main` after
the merge:

```
gh workflow run cleanup.yml
  -> run 34066657618 success in 30 s, sweep output: (nothing to reconcile)
```

**Every line of the acceptance test is green.**

### Deviations from the plan

1. **`Site` warns on `auth` rather than throwing, and its bucket is `DESTROY` +
   `autoDeleteObjects`.** The warning matches `PreviewSite`'s Epoch 2 shape
   (`@tylerschloesser/cdk-core:siteAuthNotImplemented`). The removal policy is a real choice:
   the prod bucket holds only build output, every byte of it reproducible from a deploy, and
   the plan's Teardown section promises `cdk destroy CdkCoreSite` removes everything. A
   consumer with a bucket that holds something else should pass their own.
2. **`GithubDeployRoleProps` grew `ownerId` and `repoId`.** The drafted API had only `repo`,
   which cannot build GitHub's immutable `repo:<owner>@<ownerId>/<name>@<repoId>:…` subject.
   The alternative — a wildcard on the owner id — would trust any account that ever takes the
   name `tylerschloesser`, which is the exact thing the immutable form exists to prevent. Both
   forms are trusted when both ids are given; only the legacy form otherwise.
3. **The KVS ARN and preview bucket name reach the role's IAM via
   `ssm.StringParameter.valueFromLookup`, so `infra/cdk.context.json` is now committed.**
   `valueForStringParameter` yields a `{{resolve:ssm:…}}` deploy-time token, which cannot
   appear inside an IAM resource ARN. The cost: the first synth on a machine with no cached
   context produces `dummy-value-for-…` and a template-validation *warning* until the lookup
   runs once with credentials.
4. **The sweep bin is bundled CommonJS, and `packages/cdk-core` now has a `prepare` script.**
   Two failures found by running things, neither reachable by a unit test:
   - Bundled as **ESM**, the CLI builds clean and dies on its first AWS call with
     `Dynamic require of "node:https" is not supported` — the SDK's CJS dependencies
     `require()` at runtime and esbuild's ESM output has no `require` to give them. Now
     `--format=cjs` with `dist/bin/package.json` = `{"type":"commonjs"}`, the same trick
     `dist/handlers/` already used.
   - `pnpm exec cdk-core sweep` in CI failed with `Command "cdk-core" not found`. pnpm creates
     a workspace bin link only if the bin's target exists **at install time**, and
     `dist/bin/sweep.js` is a build artifact, so a fresh clone never gets the link — and
     building afterwards does not repair it: a second `pnpm install` short-circuits with
     "Already up to date" and relinks nothing, `--force` included (all four combinations
     measured). A `prepare` script on the package is the fix; pnpm runs it during
     `pnpm install --frozen-lockfile` on a clean tree. `cleanup.yml` therefore has no build
     step of its own, and says so in a comment.
5. **`pr-teardown.yml` needed `GH_REPO`.** Its first real run deleted `CdkCore-pr-3` correctly
   and then went red on the comment: `gh pr comment` with no checkout has no git remote to
   infer the repository from and exits 1 with `failed to run git: fatal: not a git repository`.
   Not having a checkout is the *point* of that workflow, so the fix is to tell `gh` where it
   is, not to add a checkout.
6. **`distributionOverrides` could previously replace the behaviors** on `PreviewSite`, because
   it was spread last — directly contradicting its own doc comment. `safeDistributionOverrides`
   strips `defaultBehavior`, `additionalBehaviors`, `domainNames` and `certificate`, and the
   remainder is spread *before* them so `priceClass`, `logging` and friends still work. A
   `Site` test asserts a hostile override changes the price class and nothing else.
7. **`CdkCoreSite` was deployed by hand first, then by `deploy.yml`.** The plan's acceptance
   test has `deploy.yml` create it, but `workflow_dispatch` requires the workflow on the
   default branch, and a first CloudFront create is a four-minute round trip to discover a
   construct bug in. Deploying by hand first put construct failures on a 4-minute local loop;
   `deploy.yml` then proved the workflow rather than the construct. Both paths are green.
8. **Five workflows, not four.** `ci.yml` already existed from Epoch 1; the plan's "the three
   workflows" in the section title undercounts its own deliverables list, which names four.

### Left undone / untested

- **Nothing has raced two PR deploys**, still. The KVS retry loop has still only met a fake
  client and a single-writer live store. Epoch 6 owns it.
- **The sweeper has never actually deleted anything.** Every live run found either an open PR
  or nothing. Its delete paths are covered only by the fake-client tests; A8 asks for a
  deliberately orphaned key, prefix and stack, and that is still owed (Epoch 6, or by hand).
- **`CachePolicies.originDecides` is not used by the reference site.** It is unit-tested and
  offered; no deployed behavior uses it.
- **All `auth` props still warn and do nothing**, on `Site` as well as `PreviewSite`.
- The bounce host is still only unit- and `test-function`-tested. Unchanged from Epoch 2.

### AWS resources alive after this epoch

`CdkCoreShared` (the ACM certificate), `CdkCorePreview` (distribution `E3DN700ELXRXMT`, bucket
`cdkcorepreview-previewassets8b9f2052-z0r9uodmnime`, KVS `c23e3678-4dea-4cf8-b6d2-1aa0b8e1f364`,
the router function, two wildcard DNS records, four SSM parameters), **`CdkCoreSite`** (bucket,
distribution, SPA function, apex A/AAAA, two Lambdas + function URLs) and **`CdkCoreGithubOidc`**
(the IAM role `cdk-core-github-deploy`). Plus the account-level budget
`account-monthly-10-usd`, which is not in any stack. Idle cost is CloudFront/S3 pennies.

**No PR stack is alive**; `CdkCore-pr-3` and `CdkCore-pr-4` were both created, verified and
deleted, and the KVS and the preview bucket were confirmed empty afterwards.

To remove everything:

```
AWS_PROFILE=admin pnpm build
AWS_PROFILE=admin pnpm --filter infra exec cdk destroy CdkCoreSite CdkCorePreview CdkCoreShared CdkCoreGithubOidc
gh variable delete AWS_DEPLOY_ROLE_ARN
AWS_PROFILE=admin aws budgets delete-budget --account-id 063257577013 --region us-east-1 --budget-name account-monthly-10-usd
```

To remove a leaked PR stack (only ever a name read back from `list-stacks`):

```
AWS_PROFILE=admin aws cloudformation delete-stack --region us-east-1 --stack-name CdkCore-pr-<n>
AWS_PROFILE=admin aws cloudformation wait stack-delete-complete --region us-east-1 --stack-name CdkCore-pr-<n>
```

…or just let the sweeper do it: `cdk-core sweep` without `--dry-run`.

### What the next epoch needs to know

- **`.claude/rules/cdk.md` was split in three**, because it had grown past the ~120-line
  budget `CLAUDE.md` sets: `cdk.md` keeps the stacks, the router and origins/OAC;
  `.claude/rules/workflows.md` is new (the five workflows, the deploy role, the four things
  that bit); `.claude/rules/streaming-and-kvs.md` holds the streaming contract and KVS writes.
  Each file's `paths` frontmatter is narrowed to match, so touching a workflow no longer loads
  the CloudFront-origin material and vice versa.
- **`pnpm install` now builds `packages/cdk-core`.** It has a `prepare` script, and that is
  load-bearing, not tidiness — see deviation 4 and `.claude/rules/typescript-config.md`. The
  consequence: a type error in this package fails `pnpm install`, not just `pnpm verify`.
- **`apps/web/dist` is still not built by any of that**, so `pnpm build` before any `cdk`
  command remains required. Unchanged.
- **`deploy.yml` runs on every push to `main`**, so the handoff commit itself deploys
  production. That is fine, but it means a broken `main` is a broken prod site, and the merge
  of an epoch branch is a deploy.
- **The deploy role trusts `ref:refs/heads/main` and `pull_request`, and nothing else.** A
  `workflow_dispatch` from any other branch is refused at `sts:AssumeRoleWithWebIdentity`. If a
  future epoch wants to dispatch a workflow from a branch, that is a trust-policy change, not a
  workflow change.
- **`CdkCoreGithubOidc` synthesizes on every CDK command**, including in CI, and does two SSM
  lookups. They are cached in the committed `infra/cdk.context.json`. If `CdkCorePreview` is
  ever recreated, the KVS ARN and bucket name change and that file goes stale — the role would
  then be scoped to a dead ARN and the sweeper would start getting `AccessDenied`. Delete the
  two entries and re-synth with credentials.
- **Adding a workflow means adding a template**, or `test/workflow-templates.test.ts` fails.
  It pairs the two directories by "workflow requests `id-token: write`", which is what
  distinguishes an AWS-touching workflow from `ci.yml`.
- **`Site`'s two `BucketDeployment`s must keep their `prune` asymmetry**: `true` on the hashed
  half with the unversioned globs excluded, `false` on the unversioned half. Flipping the
  second to `true` deletes every hashed asset the first just uploaded, because it only
  *includes* those globs.
- **The account now has a $10/month budget** notifying `tyler.schloesser+aws-user@gmail.com` at
  80% actual and 100% forecast. It is account-wide, not per-project, and there were none before.
- Epoch 4 owns the Google OAuth client (a human action, console-only — there is no API) and
  turning every `auth` prop from a warning into a pool. Epoch 5 owns `npm login` and the
  plugin. Both are unchanged.
- The repo is still **public**, and `plan.md`, `progress.md`, `README.md`, `CLAUDE.md`,
  `.claude/rules/cdk.md`, `docs/spikes/` and now `infra/cdk.context.json` and
  `infra/bin/app.ts` carry the account id, both zone ids, the preview distribution/bucket/KVS
  ids, the deploy role ARN and GitHub's numeric owner/repo ids. Still not credentials, still
  world-readable — **the confirm asked for after Epoch 1 is still outstanding, and this epoch
  added to the pile.**

### The merge

Epoch 3 landed on `main` in two PRs, both squashed: **PR #3** (`ebc7cb5`) with the constructs,
the sweeper and the workflows, and **PR #5** (`e1e46c3`) with the two workflow fixes, the
README and this handoff. Both got a preview and both were torn down on merge. `deploy.yml` ran
on each merge and deployed production; the final run, `34066566331`, is green and
`https://cdk-core.ty.ler.dev/api/ping` answers `{"message":"pong"}`.

Final state of the account: `CdkCoreShared`, `CdkCorePreview`, `CdkCoreSite`,
`CdkCoreGithubOidc`, and **no** `CdkCore-pr-*`. KVS `{"Items": []}`, preview bucket empty, no
open PRs. `main` is the base for Epoch 4's branch.

## Epoch 4 — Auth: Cognito + Google, the bounce, machine login, authenticated e2e — 2026-09-06 — DONE

Google login works on production and on a preview, and Claude can sign into a preview with no
browser and no Google account and then drive the UI as that user — including an authenticated
SSE stream. The prod stack contains no password path, and that is now asserted from the
outside rather than intended.

Commits `d92b3e0..10313e2` on `epoch-4-auth` (PR #7), plus the handoff commit.

### Shipped

- **`packages/cdk-core/src/user-pool.ts`** (new) — `siteUserPool()`, the pool shape both site
  constructs build: `selfSignUpEnabled: false`, `FeaturePlan.ESSENTIALS`, a password policy
  with `requireSymbols: false`, `RemovalPolicy.DESTROY`, a Google IdP reading
  `cdk-core/google-oauth` as two dynamic references, a hosted-UI prefix domain, and one
  `browser` app client. Plus `defaultDomainPrefix()`.
- **`Site.auth`** (`src/site.ts:100`) — the prod pool, `userPool`/`userPoolClient`,
  `authEnvironment`, and `auth` in the deployed `__config.json`.
- **`PreviewSite.auth`** (`src/preview-site.ts:196`, `createAuth`) — the preview pool, the
  `machine` app client (`disableOAuth`, `authFlows: {userPassword: true}`), the
  `<domain>/preview-machine-user` secret with a generated password, the `PoolUser` custom
  resource, and four new SSM parameters: `authIssuer`, `authClientId`, `authDomain`,
  `authMachineClientId`, `machineSecretArn` (five, see deviation 3).
- **`applyPoolUser`** (`src/handlers/preview-resources.ts`) — `AdminCreateUser` (SUPPRESS) →
  `readPassword` → `AdminSetUserPassword --permanent`, idempotent on
  `UsernameExistsException`, delete-tolerant of `UserNotFound`/`ResourceNotFound`. Written
  against a `PoolUserDirectory` interface, 8 unit tests against a fake.
- **`src/handler-asset.ts`** (new) — one place that resolves the bundled handler, shared by
  `PreviewSite` and `PreviewDeployment`.
- **`auth/oidc.ts`** (new) + **`auth/browser.ts`** — PKCE S256, the D5 bounce `redirect_uri`
  and `<nonce>.<pr>` state, `exchangeCode`/`refreshTokens`, a 5-minute refresh window with a
  shared in-flight promise, `handleCallback` returning the return path. 22 unit tests
  including the RFC 7636 Appendix B vector.
- **`auth/server.ts`** — `createVerifier` on `aws-jwt-verify` (`tokenUse: 'id'`, the user pool
  id parsed out of the issuer), cached per `(issuer, clientId)`, a comma-separated client
  allowlist, and a `getUser` `cognito` branch that throws on missing env and returns `null` on
  an invalid token. 17 unit tests.
- **`apps/api/src/events.ts`** — `/events/tick` requires auth. **`apps/web/src/App.tsx`** — a
  `sign in with Google` button in non-local mode, and the callback returns to `returnTo`.
- **`e2e/fixtures.ts`** (new), `auth.spec.ts`, `sse.spec.ts` — `machineAuth`/`authedPage` and
  the exported `TARGET`. **`scripts/preview-login.sh`** (new).
- **`GithubDeployRole`** — `secretsmanager:GetSecretValue` on
  `secret:<domain>/preview-machine-user-*` and nothing else new.
- **`.claude/rules/auth.md`** (new); `cdk.md`, `workflows.md`, `testing.md` corrected.

### Acceptance test

```
$ gh run list --branch epoch-4-auth --limit 2
CI: success @ 10313e2
PR Preview: success @ 10313e2          # 8 passed, 2 skipped — includes the auth spec,
                                       # the prod-isolation negative test and authed SSE

$ ./scripts/preview-login.sh 7 | xargs -I{} curl -fsS -H 'x-id-token: {}' https://pr-7.preview.cdk-core.ty.ler.dev/api/me
xargs: command line cannot be assembled, too long        # the plan's form cannot work — see deviation 1

$ curl -fsS -H "x-id-token: $(./scripts/preview-login.sh 7)" https://pr-7.preview.cdk-core.ty.ler.dev/api/me
{"sub":"84e844c8-b021-70bb-da84-7ff387914192","email":"claude@cdk-core.ty.ler.dev"}

$ curl -sS -o /dev/null -w '%{http_code}\n' -H "x-id-token: $(./scripts/preview-login.sh 7)" https://cdk-core.ty.ler.dev/api/me
401

$ aws cognito-idp describe-user-pool-client --user-pool-id us-east-1_havW5h4hk \
    --client-id 7mrijhcfmdutdqbk5709dkf22l --query 'UserPoolClient.ExplicitAuthFlows'
[
    "ALLOW_REFRESH_TOKEN_AUTH"
]

$ aws cognito-idp list-users --user-pool-id us-east-1_havW5h4hk \
    --query 'Users[?UserStatus!=`EXTERNAL_PROVIDER`]'
[]
```

The manual half, done by the user: **Google login works on `https://cdk-core.ty.ler.dev` and
on `https://pr-7.preview.cdk-core.ty.ler.dev`**, both landing back on the page signed in. The
preview signed them in with no second consent screen — expected, and the visible upside of
D4's one-Google-client-for-all-sites: the two *pools* are separate and their tokens live in
separate origins' `localStorage`, but Google's session and consent grant are shared, so the
second trip through `identity_provider=Google` is silent.

Extra checks the plan did not ask for but which pin the parts a green suite would not
distinguish:

```
bounce, valid PR      302 -> https://pr-7.preview.cdk-core.ty.ler.dev/auth/callback?code=abc123&state=Zm9vYmFy.7
bounce, unknown PR    404      (state=….999999 — no KVS key)
bounce, no state      404
bounce, injected URL  404      (state=https://evil.example.com)
anonymous /api/me, /events/tick, garbage token   401, 401, 401  (preview and prod)
```

**A6 is now met with auth.** Authenticated SSE through the preview distribution, 7 samples:
1st→5th spread **median 2003 ms, range 2000–2003**; 1st→2nd **median 500 ms, range 499–501**,
which is the producer's interval exactly — nothing buffers anywhere. Target was ≥ 400 ms.

**A7 is met**, by the four lines above: refresh-only flows, zero native users, a preview token
refused by production, and `/api/me` 401 for an anonymous caller.

### Deviations from the plan

1. **The acceptance test's `xargs -I{}` form cannot work, on macOS at least.** `xargs -I`
   caps a replacement line at 255 bytes and a Cognito ID token is ~1050, so it fails with
   `command line cannot be assembled, too long` before curl ever runs. `$(…)` is the form that
   works and is what `.claude/rules/auth.md` and the plan now show.
2. **CDK's `UserPoolClient` L2 cannot express "refresh only".** `configureAuthFlows` returns
   `undefined` for an **empty** `authFlows` as well as an absent one, which omits
   `ExplicitAuthFlows` from the template — and an omitted list makes Cognito apply its legacy
   defaults, which include `ALLOW_USER_SRP_AUTH`. The plan's `authFlows: {}` **explicitly**
   would therefore have produced the opposite of what it intended, silently. Pinned on the L1
   (`cfnClient.explicitAuthFlows = ['ALLOW_REFRESH_TOKEN_AUTH']`) and asserted in
   `site.test.ts`. (`authFlows: { userSrp: false }` also happens to work, by being non-empty;
   it was rejected as too clever to survive a refactor.)
3. **A preview API must trust *two* app clients, not one.** Measured, not inferred: the token
   `scripts/preview-login.sh` mints carries the **machine** client as its `aud`, while
   `authClientId` — what the browser authorizes with and what the Lambdas had — is the
   **browser** client. A verifier given one 401s every call made with the other. `aud` is the
   client that minted a token, not the pool, and the boundary that isolates prod from preview
   is the pool (`iss`), so `AUTH_CLIENT_ID` became a comma-separated allowlist and
   `PreviewSite` publishes `authMachineClientId` as a fifth parameter. The plan's D6 assumed
   the machine token would simply be accepted.
4. **`PreviewSite` publishes `authDomain` too.** The plan lists `authIssuer`, `authClientId`
   and `machineSecretArn`. The hosted-UI host cannot be derived from the issuer, and the
   browser needs it for both the authorize redirect and the token exchange.
5. **`PreviewDeploymentProps` gained `auth?: boolean`.** A PR stack cannot detect whether the
   site has a pool: `ssm.StringParameter.valueForStringParameter` on a parameter that does not
   exist fails the *deploy*, not the synth, so there is nothing to branch on at build time.
   The consumer already knows — it passed `auth` to `PreviewSite` in the same `bin/app.ts`.
6. **The e2e suite has three targets, not two, and `.claude/rules/testing.md` is corrected.**
   Production has no machine user and cannot have one — that *is* A7 — so `machineAuth` throws
   there, the authenticated specs skip, and production asserts the 401 instead. The
   consequence worth knowing: **`deploy.yml`'s post-deploy run can no longer exercise the
   production SSE stream**, because `/events/tick` now requires auth. Epoch 3's unauthenticated
   production measurement (2040 ms) stands; the authenticated one is now a preview measurement
   plus a human clicking `stream` after a Google login.
7. **A `test.skip` inside a test body is too late.** Playwright resolves a test's fixtures
   before running the body, so the first production run failed three specs instead of skipping
   them: `machineAuth` threw first. The skips are now at `test.describe` scope.
8. **`vitest`'s 5 s default timeout is too small for the synth tests.** CI went red on two
   tests whose assertions were all correct: `Template.fromStack` stages and zips every
   `Code.fromAsset`, CDK's provider framework included, and on a two-core runner with a dozen
   files in flight that exceeded 5 s. `testTimeout: 30_000` as a hang guard, and
   `preview-site.test.ts` memoises its synth per `auth` value. The suite still takes ~3 s
   locally.
9. **`previewResourcesAssetPath()` special-cases being loaded from `src/`.** A vitest run
   imports the constructs from source, where `dist/handlers/preview-resources` does not exist,
   and `Code.fromAsset` throws `CannotFindAsset` before any assertion runs. It returns
   `src/handlers` in that case — keyed on the *directory name*, not on "does the bundle
   exist", so a real deploy from an unbuilt `dist/` still fails loudly.
10. **`Site`/`PreviewSite` take an explicit `domainPrefix` in `infra/bin/app.ts`.** The
    Construct API's default is the domain with dots → dashes (`cdk-core-ty-ler-dev`), but the
    epoch's human-action text — and therefore the Google client's redirect URIs — says
    `cdk-core` and `cdk-core-preview`. The value that has to match a human's console typing is
    a literal in `bin/app.ts` with a comment saying why, not a derivation.
11. **`CdkCoreSite` was deployed by hand before the PR merged**, exactly as in Epoch 3 and for
    the same reason: the acceptance test needs a live prod pool to prove the negative against,
    and a Cognito failure is better found on a 90-second local loop. `deploy.yml` re-deploys it
    on merge.
12. **`aws-jwt-verify` is a real `dependencies` entry**, not an optional peer like
    `aws-cdk-lib`. It is zero-dependency and a Lambda importing `auth/server` from the
    published tarball must get a working verifier with no extra install step.

### Left undone / untested

- **The refresh path has never refreshed a real Cognito token.** It is unit-tested against a
  fake token endpoint and the window is 5 minutes against a 1-hour token, so no e2e run or
  manual check has reached it. First real exercise is a browser tab left open for 55 minutes.
- **`logout()` is local-only.** It clears `localStorage`; it does not call Cognito's `/logout`
  endpoint, so the pool session (and Google's) survive. That is why the preview signed the user
  in silently, and it is fine for this reference site — but a consumer who wants a real sign-out
  needs the hosted-UI logout redirect, which is not implemented.
- **Nothing has raced two PR deploys** (unchanged from Epoch 3).
- **The sweeper has still never deleted anything** (A8, unchanged — Epoch 6 owes it).
- **`CachePolicies.originDecides` is still unused** by the reference site.
- The Google consent screen is still in **Testing**, with the user as the only test user.

### AWS resources alive after this epoch

`CdkCoreShared`, `CdkCorePreview` (now also the preview user pool `us-east-1_D9US7hu40`, the
`browser` and `machine` clients, the `claude` user, the secret
`cdk-core.ty.ler.dev/preview-machine-user`, and a second Lambda + provider for `PoolUser`),
`CdkCoreSite` (now also the prod user pool `us-east-1_havW5h4hk` and its one client) and
`CdkCoreGithubOidc`. Plus the account-level budget. Two user pools idle at $0; two secrets at
$0.40/month each.

To remove everything (the two secrets are *named*, so a plain stack delete leaves a 30-day
tombstone that blocks recreating the name — force-delete them):

```
AWS_PROFILE=admin pnpm build
AWS_PROFILE=admin pnpm --filter infra exec cdk destroy CdkCoreSite CdkCorePreview CdkCoreShared CdkCoreGithubOidc
AWS_PROFILE=admin aws secretsmanager delete-secret --region us-east-1 \
  --secret-id cdk-core.ty.ler.dev/preview-machine-user --force-delete-without-recovery
AWS_PROFILE=admin aws secretsmanager delete-secret --region us-east-1 \
  --secret-id cdk-core/google-oauth --force-delete-without-recovery
gh variable delete AWS_DEPLOY_ROLE_ARN
AWS_PROFILE=admin aws budgets delete-budget --account-id 063257577013 --region us-east-1 --budget-name account-monthly-10-usd
```

### What the next epoch needs to know

- **The Cognito prefix domains are `cdk-core` and `cdk-core-preview`**, and they are literals
  in `infra/bin/app.ts` because they must equal what was typed into the Google OAuth client's
  redirect URIs. Changing either means editing the Google console in the same change, and the
  failure mode is a `redirect_uri_mismatch` at Google with nothing in any AWS log. The
  cheap pre-check, no browser needed: fetch the Cognito `/oauth2/authorize` URL, follow its
  `Location`, and confirm Google answers with a sign-in page rather than `Error 400`.
- **`AUTH_CLIENT_ID` is a comma-separated allowlist.** Anything that adds an app client to the
  preview pool and wants the API to accept its tokens must add it there too.
- **`deploy.yml`'s production e2e no longer covers the SSE stream** (deviation 6). If a future
  epoch wants that back, the options are an unauthenticated health-stream route or a prod
  machine user — and the second one deletes A7.
- **Two secrets are named, not stack-owned, in the sense that matters**: deleting the stack
  schedules them for deletion with a recovery window, and the name stays reserved until it
  elapses. Recreating `CdkCorePreview` within 30 days of a destroy needs the force-delete
  above first.
- **`packages/cdk-core` now has a runtime `dependencies` block** (`aws-jwt-verify`). Epoch 5's
  packaging work has to keep it there — an optional peer would ship a tarball whose
  `auth/server` throws on import.
- **The handler bundle grew from 1.1 MB to 1.4 MB** (Cognito + Secrets Manager clients). It is
  uploaded on every PR deploy; repeat deploys still measured 33 s, so it has not cost anything
  yet.
- **`.claude/rules/cdk.md` is 132 lines**, over the ~120 `CLAUDE.md` asks for — it was already
  130 before this epoch. Split it (origins/OAC is the natural seam) the next time it grows.
- Epoch 5 still owes `npm login`, the plugin and the marketplace. Nothing else is owed by a
  human for Epoch 5.
- The repo is still **public**, and the account id, both zone ids, the preview
  distribution/bucket/KVS ids, the deploy role ARN, GitHub's numeric ids and now **both user
  pool ids and the two app client ids** are in tracked files. Pool and client ids are not
  credentials — they appear in every authorize URL — but the confirm asked for after Epoch 1 is
  still outstanding and this epoch added to it again.

### The merge

Epoch 4 landed on `main` as **PR #7** (`eee3393`), squashed. Both `CI` and `PR Preview` were
green on the final commit (`88b5adf`), `pr-teardown.yml` deleted `CdkCore-pr-7` on close (run
`34069548880`), and `deploy.yml` deployed production on the merge (run `34069548866`) — its
post-deploy e2e run against `https://cdk-core.ty.ler.dev` is 5 passed, 5 skipped, the five
skips being the machine-auth specs that production has no identity for by design.

Final state of the account: `CdkCoreShared`, `CdkCorePreview`, `CdkCoreSite`,
`CdkCoreGithubOidc`, and **no** `CdkCore-pr-*`. KVS `[]`, preview bucket empty,
`cdk-core sweep --dry-run` printed `(nothing to reconcile)` and exited 0,
`https://cdk-core.ty.ler.dev/api/ping` answers `{"message":"pong"}`, and
`scripts/verify-preview.sh 7 --expect-absent` is 7 passed, 0 failed.

One thing to know about that last check: run immediately after `pr-teardown.yml` completes it
reported **5 passed, 2 failed**, and a re-run a minute later was 7/7. The stack delete removes
the KVS key, but the edge has already-cached 200s for paths it served seconds earlier. Give it
a minute before treating an `--expect-absent` failure as real.

`main` is the base for Epoch 5's branch.
