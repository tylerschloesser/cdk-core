---
paths:
  - "e2e/**"
  - "**/*.test.ts"
  - "**/vitest.config.ts"
  - "**/playwright.config.ts"
---

# Testing: what goes where, and what an assertion has to prove

Loaded when you touch a spec, a test, or a test config.

## Two suites, two jobs

**vitest** (`packages/cdk-core/test/`, run by `pnpm test`) covers the pure pieces: the SSE
parser, the body hash, the router and SPA renderers, the KVS retry loop and the sweeper's
reconciliation against fakes. **From Epoch 3 it also asserts synthesized CloudFormation**
(`Template.fromStack` from `aws-cdk-lib/assertions`) for `Site` and `GithubDeployRole` — that
is still pure, because `Template.fromStack` neither calls AWS nor needs a build. Nothing in a
vitest file may open a socket, read AWS credentials, or need a build; an SSM
`valueFromLookup` inside one resolves to CDK's `dummy-value-for-…` placeholder and that is
fine, but nothing may *depend* on the real value.

`testTimeout` is **30 s**, not vitest's 5 s default: `Template.fromStack` synthesizes the app,
which stages and zips every `Code.fromAsset` (CDK's own provider framework included), and on a
two-core CI runner that alone exceeded 5 s and failed a run whose assertions were all correct.
It is a hang guard, not a budget — the suite takes ~3 s locally. A test that synthesizes the
same stack more than once should memoise it instead of leaning on the timeout.

**Playwright** (`e2e/`, run by `pnpm e2e`) covers everything that is only true when the whole
thing is wired together. **One config, three targets** is the design and it is not negotiable:

```
pnpm e2e                                                     # boots `pnpm dev` and tests localhost
PLAYWRIGHT_BASE_URL=https://pr-12.preview.cdk-core.ty.ler.dev pnpm e2e   # the identical specs
PLAYWRIGHT_BASE_URL=https://cdk-core.ty.ler.dev pnpm e2e                 # what deploy.yml runs
```

A spec that only passes against local is a spec that proves nothing about a preview. Anything
environment-specific goes behind the `machineAuth`/`authedPage` fixtures in `e2e/fixtures.ts`,
or behind a `test.skip` keyed on the exported `TARGET` — never behind a branch inside a
`test()` body.

**[Epoch 4] The third target really is different, and not because of a gap.** `TARGET` is
`local | preview | prod`, and **prod has no machine identity and cannot have one**: the prod
pool has no native users and its only client's `ExplicitAuthFlows` is refresh-only, which *is*
A7. So `machineAuth` throws against prod (loudly, rather than yielding a token that 401s twenty
lines later), the authenticated specs skip there, and what production asserts instead is the
**401** — that the endpoints are protected. The signed-in half of production is a human doing a
Google login, recorded in `progress.md`.

`@playwright/test` is a dependency of the `e2e` package, not of the root, so the browser
install is `pnpm --filter e2e exec playwright install chromium` — a bare `pnpm exec playwright`
from the root fails with "Command not found", which is exactly how CI found this.

The local target's readiness URL is `http://localhost:5173/api/ping` — through Vite's proxy,
so one poll proves both the static server and the API are up.

## Assert the mechanism, not the payload

The failure modes this stack has are the ones that leave the payload intact:

- **Streaming.** `e2e/sse.spec.ts` asserts *inter-arrival timing* read from
  `data-received-at`, which the web app stamps at the moment `readSse` yields each frame. A
  proxy that buffers the whole response and flushes it at the end delivers the same five
  events with the same content; only the timing separates it from a real stream. Bounds are
  1st→5th ≥ 400 ms (a fifth of the 2000 ms the producer takes, so a slow runner cannot make
  it flaky) and 1st→2nd ≤ 1500 ms. If you change the producer's interval, change both bounds
  and say why in the same commit.
- **The body hash.** `/api/echo` is a POST *with a body* on purpose: under origin access
  control a POST body 403s at the function URL unless the viewer computed
  `x-amz-content-sha256` itself. A test that only exercises GETs would pass all the way to
  production and fail there.
- **Auth.** Assert the 401 as well as the 200. From Epoch 4 the negative test — a preview
  token against the prod API — is the one that proves the pools are actually isolated.

## Timing claims

Three samples are not a measurement (`CLAUDE.md`). A number that goes into `progress.md` or
`plan.md` is a median with a range over interleaved, randomized runs, not a best-of-three.
