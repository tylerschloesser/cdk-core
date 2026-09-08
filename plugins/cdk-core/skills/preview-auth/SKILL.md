---
name: preview-auth
description: Use when Claude needs to sign into a PR preview to test authenticated behavior, curl a protected endpoint, or seed a Playwright session — with no browser and no Google account.
---

# Machine auth for previews

## Why this exists, and why it is preview-only

The preview Cognito pool has a native user (`claude`, username configurable, default
`claude`) and a `machine` app client with `ALLOW_USER_PASSWORD_AUTH`. Claude signs in as that
user with a real password and gets back real tokens — no browser, no Google OAuth round trip.

This does not exist in production, and that is deliberate (acceptance criterion A7), not a
gap: the production pool has **no native users at all**, and its only app client's
`ExplicitAuthFlows` is `['ALLOW_REFRESH_TOKEN_AUTH']` — no password flow to call. There is no
flag to flip and no fallback. If you send a preview ID token to the production API, you get
**401**, because the token's issuer (`iss`) is the preview pool, not the production pool, and
the production verifier only trusts its own pool. That 401 is itself an assertion in the e2e
suite (`e2e/auth.spec.ts`'s "a preview token is rejected by production" test) — it is the
proof that the two pools are actually isolated, not just separate.

## First: is the site gated?

Everything below describes a site **without** `auth.gate` — the default, and what
`cdk-core.ty.ler.dev` itself runs. If the consumer's `bin/app.ts` has `auth: { …, gate: 'edge' }`,
three things in this skill change and the rest still holds. Check before you start; the symptom
of getting it wrong is a `302` or a `401` from a `curl` that looks like a broken token.

| | ungated (default) | `gate: 'edge'` |
| --- | --- | --- |
| credential on the wire | `x-id-token` header | `__Host-cdkcore-session` cookie |
| `preview-login.sh` prints | a fresh ID token | a **cookie jar path**, and `<pr>` is required |
| `curl` | `-H "x-id-token: $(…)"` | `-b "$(scripts/preview-login.sh <pr>)"` |
| Playwright | `addInitScript` seeds `localStorage` | `context.request.get('/auth/session')` first |

Why: with the gate, a request carrying only `x-id-token` is refused **at the edge**, before it
reaches any Lambda — `/auth/*` is the one ungated path. So the ID token below is still exactly
what you mint, it just has one more hop: `GET /auth/session` with the token in `x-id-token`
returns `204` and a `Set-Cookie`, and everything after that is the cookie.

`page.addInitScript` cannot work against a gated target at all, and this is worth understanding
rather than working around: an init script only runs once a page has loaded, and a gated
navigation never reaches a page. Use an `APIRequestContext` taken **from the browser context**
(`page.context().request`), never `request.newContext()` — only the context-bound one shares the
cookie jar the later `page.goto()` reads, and the standalone form fails as a redirect loop that
names nothing.

## The secret

Each site's machine-user credentials live in Secrets Manager at
`<domain>/preview-machine-user`, holding JSON `{username, password, clientId, userPoolId}`.
For this repo that's `cdk-core.ty.ler.dev/preview-machine-user`.

`cognito-idp initiate-auth --auth-flow USER_PASSWORD_AUTH` is an **unauthenticated** Cognito
API, so it is called with `--no-sign-request` and needs no IAM permission at all. The only
permission this path needs is `secretsmanager:GetSecretValue` on that one secret ARN.

## Minting a token and curling with it

```
scripts/preview-login.sh
```

prints a fresh ID token on stdout (and nothing else — every diagnostic goes to stderr). It
takes an optional, unused PR-number argument (the machine user is per-site, not per-PR, since
every preview under a site shares the same pool) and reads `CDK_CORE_DOMAIN` to override the
default `cdk-core.ty.ler.dev`.

```
curl -fsS -H "x-id-token: $(scripts/preview-login.sh)" https://pr-<n>.preview.<domain>/api/me
```

Use `$(…)`, not a pipe into `xargs -I{}`. The `xargs -I` form caps a replacement line at 255
bytes, and a Cognito ID token is roughly 1050 bytes — it gets silently truncated and every
call 401s with no clue why.

## Why `x-id-token`, not `Authorization`

The preview distribution's origin request policy is `ALL_VIEWER_EXCEPT_HOST_HEADER`, forwarding
everything to the origin except the `Host` header. By the time that policy runs, CloudFront's
own OAC SigV4 signature has already been written into the `Authorization` header — sending
your own bearer token there would collide with (and be overwritten by) CloudFront's signature.
The app therefore reads auth from a header CloudFront never touches: `x-id-token`.

## Which token, and which client

Always the **ID token**, never the access token. `InitiateAuth`'s access tokens carry only the
`aws.cognito.signin.user.admin` scope — nothing the API can authorize on. The ID token carries
`sub`, `email`, and whatever else the pool maps, which is what `auth/server`'s verifier checks.

A preview API trusts **two** app client ids: `AUTH_CLIENT_ID` is a comma-separated allowlist,
because a token's `aud` claim is the client that minted it, and a human's browser login mints
a token with `aud: browser` while the machine user's `initiate-auth` mints one with
`aud: machine`. Trusting both does not weaken anything — the isolation that actually matters
is the *pool*, enforced by `iss`, and both clients belong to the same preview pool.

## The lockout

Cognito locks the user out after 5 consecutive failed password attempts, with a rising
backoff. If `initiate-auth` fails, **do not** loop and retry it — that just extends the
lockout. Fetch the secret again instead: the usual cause of a failure is a stack update that
rotated the generated password, and the secret always has the current one.

## Seeding a Playwright session

`e2e/fixtures.ts`'s `authedPage` fixture calls `page.addInitScript` before the first
navigation to write straight into `localStorage`:

```js
window.localStorage.setItem(
  'cdkcore:auth',
  JSON.stringify({ idToken, accessToken, expiresAt: Date.now() + 60 * 60 * 1000 }),
)
```

`cdkcore:auth` is the app's own storage key, not Amplify's internal one — that's what makes
seeding it from outside the app work at all: the app reads the same key back on load and never
knows the tokens didn't come from a real OAuth round trip. The full shape (per `plan.md`'s D6)
is `{idToken, accessToken, refreshToken?, expiresAt}`; the fixture only sets what it needs.

## Local dev has no Cognito at all

`pnpm dev` runs with `AUTH=local`. There is no pool, no client, no secret, no network call.
The dev-login box calls `login(devUser)` from `auth/browser`, which stores a literal
`dev:<name>` string as the token; the backend, running with `AUTH=local`, trusts any
`x-id-token` starting with `dev:` and reads the name back out of it. This is why the
unauthenticated and authenticated e2e specs run unmodified against local, preview, and (for
the unauthenticated ones) production — only the fixture that produces the token differs per
target.
