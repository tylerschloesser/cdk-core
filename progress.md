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
