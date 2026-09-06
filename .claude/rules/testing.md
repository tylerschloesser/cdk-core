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

**vitest** (`packages/cdk-core/test/`, run by `pnpm test`) covers the pure pieces only: the
SSE parser, the body hash, and — from Epoch 2 on — the router renderer and the KVS retry loop
against a fake client. Nothing in a vitest file may open a socket, read AWS credentials, or
need a build.

**Playwright** (`e2e/`, run by `pnpm e2e`) covers everything that is only true when the whole
thing is wired together. **One config, two targets** is the design and it is not negotiable:

```
pnpm e2e                                                     # boots `pnpm dev` and tests localhost
PLAYWRIGHT_BASE_URL=https://pr-12.preview.cdk-core.ty.ler.dev pnpm e2e   # the identical specs
```

A spec that only passes against one of the two targets is a spec that proves nothing about a
preview. Anything genuinely environment-specific (machine auth in Epoch 4) goes behind a
fixture that keys off `PLAYWRIGHT_BASE_URL`, never behind a branch inside a `test()` body.

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
