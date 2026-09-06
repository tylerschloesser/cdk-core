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

Commits `4cee88d..b7d1521` on `epoch-2-preview-topology`.

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
