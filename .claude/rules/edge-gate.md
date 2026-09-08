---
paths:
  - "packages/cdk-core/src/router/gate.ts"
  - "packages/cdk-core/src/auth/session.ts"
  - "packages/cdk-core/src/handlers/auth-endpoint.ts"
  - "packages/cdk-core/src/kvs-secret.ts"
---

# The edge gate: the whole site behind Google

Loaded when you touch the gate, the session codec, the `/auth/*` Lambda or the KVS secret
writer. Three neighbours: `auth.md` (the pools, the Google client, the machine user),
`cdk.md` (the router, the distributions, the CloudFront Function dialect) and
`streaming-and-kvs.md` (KVS writes and propagation). `plan.md` D1's *Revisited* note says why
this is a CloudFront Function and not Lambda@Edge.

Opt in with `auth: { gate: 'edge' }`. Without it every construct synthesizes exactly as it did
before — `site.test.ts` and `preview-site.test.ts` both assert that, and it is the assertion
that keeps an ungated consumer safe from this feature.

```
                    ┌─ no cookie ──→ 302 to Cognito hosted UI (Google)
viewer ─→ CF Function ┤                          │
          (gate)     └─ valid cookie ─→ cache ─→ origin
                                                 │
  /auth/callback ─→ (ungated) ─→ auth Lambda: code → tokens → Set-Cookie → 302 returnTo
```

## Anyone with a Google account gets in

There is **no allowlist**. "Gated" means gated from people who will not click "Sign in with
Google" — not from any particular person. That is a deliberate choice. The one-line fix if it
stops being acceptable is an email check in `auth/server`'s `getUser` **plus** the same check
in `handlers/auth-endpoint.ts` where the session cookie is minted; changing only one of them
leaves a way in.

## Three implementations of two formats, and they must agree

The cookie and `state` formats each exist in three places: `src/auth/session.ts` (Node),
`src/router/gate.ts` (the generated CloudFront Function), and `src/handlers/auth-endpoint.ts`
(which uses the Node one). The edge copy **cannot import** the others, so the tests recompute
the values with `node:crypto` rather than sharing an implementation — that is the point of
them, not an oversight. Change a format and all three change in one commit.

- **Session cookie** `__Host-cdkcore-session` = `v1|<sub>|<email>|<exp>` + `.` + HMAC-SHA256 of
  that payload, **lowercase hex**. `HttpOnly; Secure; SameSite=Lax; Path=/`, no `Domain` — the
  `__Host-` prefix forbids one, which is what gives every preview host and prod their own
  host-only session with nothing leaking between them.
  - Delimited, not `base64url(JSON)`. `atob` does exist in `cloudfront-js-2.0`, but the edge
    only needs `exp`, and a delimited payload makes that one `lastIndexOf('|')` instead of a
    base64url→base64 padding dance plus a `JSON.parse`. The signature is split at the **last**
    `.`, which is unambiguous because `exp` is all digits even though an email contains dots.
  - Not `cdkcore:session`: `:` is a separator in RFC 6265's `token` grammar, so it is not a
    legal cookie name. The `localStorage['cdkcore:auth']` key is fine — a cookie cannot copy it.
- **`state`** = `<iat>.<hexsig>` on prod, `<iat>.<hexsig>~<pr>` on preview. Every character is
  in the preview router's `^[A-Za-z0-9._~-]+$` query allowlist, which is why the signature is
  hex and not base64url.
  - **The `~` is load-bearing.** The router recovers the PR from the last segment. `~` is in
    the allowlist but is not a hex character, so the split is unambiguous. Widening the old
    `.`-separated pattern instead **does not work**: a hex signature can end in a run of
    digits, and greedy backtracking then extracts the wrong PR with no error. `render.ts`
    keeps two patterns — the `~` form first, the legacy `<nonce>.<pr>` SPA form second.
  - **Cognito sends the `~` back percent-encoded as `%7E`, and CloudFront Functions do not
    decode query-string values.** So the bounce branch must `decodeURIComponent` `state` (and
    `code`, and `error`) *before* matching and before the allowlist check. Without that, every
    real sign-in ends on the bounce host's bare `404 no such preview` while every synthetic
    test stays green, because a hand-written test passes the raw `~`. `~` is unreserved in RFC
    3986, so leaving it alone and encoding it are **both** legal and a receiver must treat them
    as equivalent — do not "fix" this by picking a different separator, because the next
    character can be encoded too. Decoding first is also the safer order: anything that needed
    encoding cannot pass `^[A-Za-z0-9._~-]+$` once decoded, so the re-forwarded value is safe
    by construction.
    Reproduce with no browser and no login — ask the hosted UI for an invalid scope and it
    bounces straight back to `redirect_uri`, echoing `state` through its own encoder:
    ```
    curl -sSD- -o /dev/null "https://<prefix>.auth.<region>.amazoncognito.com/oauth2/authorize\
      ?client_id=<id>&response_type=code&scope=not_a_real_scope\
      &redirect_uri=<urlencoded>&state=1700000000.deadbeef~17"
    ```
  - The PR is *inside* the signed body (`<iat>~<pr>`) but *after* the signature in the emitted
    string. That asymmetry is deliberate: the regex needs it last, the signature needs it
    covered.

## PKCE with no CSPRNG

The edge cannot generate a random verifier — `Math.random()` is seeded from the function's
start time and `Date` is frozen for the invocation. So the verifier is **derived**:
`HMAC-SHA256(secret, 'pkce|' + <state signed body>)`, hex, 64 chars, which is a legal RFC 7636
`code_verifier`. The Lambda re-derives the same value from the `state` it gets back.

This is why the app client stays **public** and there is no `edge` client: `generateSecret:
true` would drag in CDK's `AwsCustomResource` for `userPoolClientSecret`, which exposes the
secret as a readable stack `Data` attribute, and `auth/oidc.ts`'s `exchangeCode` has no
client-secret path. The gate reuses the existing `browser` client, whose callback URL is
already right on both distributions.

`crypto.createHash('sha256').update(v).digest('base64')` is the **one edge API here that AWS's
`cloudfront-js-2.0` docs do not spell out**. `aws cloudfront test-function` against the
DEVELOPMENT stage is what confirms it; nothing else prints the real error.

## The 10 KB budget, and why the generated source has no comments

A CloudFront Function's maximum size is **10,240 bytes and the quota is not adjustable**.
Measured on the two-backend reference config, the gated preview router came to **9,767 bytes,
of which 3,388 were comments** — 473 bytes of headroom against a backend block that costs
~539. So `stripSourceComments()` drops comment-only lines from the emitted source, taking it
to **6,426**, and the explanations live in the generators, where someone changing the
behaviour actually reads them.

- The strip is **line-anchored** (`^\s*//`). The emitted source contains `'https://'` inside
  string literals, and a `//`-anywhere strip would corrupt them.
- `test/router.test.ts` fails at **8,192**, not at the real limit, so it trips while there is
  still room to think. If it trips, move text out of the emitted string — do not raise it.

## Two secrets, and what can read them

Prod and preview get **different** secrets, which is what makes a preview session cookie
useless against prod. Each is a Secrets Manager secret; a `KvsSecret` custom resource copies it
into a KeyValueStore at deploy time, and every backend Lambda gets it as `AUTH_SESSION_SECRET`,
a `{{resolve:secretsmanager:…}}` dynamic reference built from the secret's **literal name** —
a dynamic reference must be a literal in the template, so it cannot be built from an ARN token,
and it creates no implicit ordering, hence the explicit `addDependency` in `defineSiteStacks`
(prod only; a PR stack's secret lives in the shared preview stack, deployed long before).

**It renders as a plain string, not an `Fn::Join`.** `auth.md` item 3 says to assert on the
serialized form because the Google client secret comes out as a join — but that is because it
goes through `secretValueFromJson()` on an **ARN**-bearing `ISecret`, and the ARN folds in the
partition pseudo-parameter. `SecretValue.secretsManager('<literal name>', …)` has no ARN and no
pseudo-parameter, so it is just a string. Both shapes exist in this repo; assert on
`JSON.stringify(...)` containing `{{resolve:secretsmanager:` and the secret's name, which holds
either way.

**A KeyValueStore is not a secret store.** `ListKeys` returns values, not just key names, and
there is no per-key IAM. Prod gets its own secret-only store precisely so nothing is ever
granted `ListKeys` on it. Preview **cannot**: the quota is one KVS per function and the router
already spends its one on routing, so the key shares the routing store — which
`src/github-deploy-role.ts` already grants `ListKeys` on to the GitHub Actions role. So **CI
can read the preview signing key**. Accepted, because a CloudFront Function has no environment
variables and no other store, and because a preview key forges only preview sessions.

## The invariants that are safety properties

- **`/auth/*` is `CACHING_DISABLED` on both distributions.** A cached `Set-Cookie` hands one
  visitor's session to the next. Asserted in both template tests, not merely commented.
- **`/auth/*` carries no CloudFront Function.** On preview the router would otherwise
  `kvs.get(host)`, see that `/auth/callback` has no extension, and rewrite the URI to
  `/pr-7/index.html` — sent to the auth Lambda's origin.
- **The gate runs on every *other* behavior**, including `/api/*` and `/events/*`. Prod's one
  function therefore takes `backends` too, so it returns `/api/v1/x` unchanged instead of
  rewriting it to `/index.html`.
- **The auth Lambda is host-blind and must stay so.** `ALL_VIEWER_EXCEPT_HOST_HEADER` strips
  `Host`, and one preview Lambda serves every `pr-N.preview.<domain>`. Every redirect it emits
  is a relative path and every cookie is host-only. Give it a hostname and PR 7's user lands on
  PR 3.
- **`safeReturnPath` rejects `/\evil.com` as well as `//evil.com`.** The WHATWG URL parser
  treats `\` as `/` for http(s), so both are parsed as an authority. Blocking only `//` is the
  version of that check that looks right and is not.

## The gate costs two `kvs.get`s, and that breaks a documented rule

`cdk.md` rule 4 says one `kvs.get` per request. The preview main path now does two — the route
lookup, then the secret. This is a conscious deviation, not an accident: the secret is needed on
every request and there is nowhere else to put it. Re-measure `ComputeUtilization` after any
change here; `cdk.md` rule 7 records the p99 at 26.4–30.0% *before* the gate, and exceeding 100
is a 503 on every request through the distribution.

## Failure modes you will actually see

- **503 `auth unavailable`** — the gate read no secret. Almost always the ~29 s window after a
  first deploy while a new KVS key propagates (`streaming-and-kvs.md`). It fails closed on
  purpose; an infinite redirect loop through Cognito would be the alternative.
- **401 `sign in required`** vs a 302 — the gate answers a 302 only when `sec-fetch-mode` is
  absent or `navigate`. A browser subresource fetch gets the 401 instead, because a redirect to
  Google is not a useful response to an `img` or an XHR. `curl` sends no `sec-fetch-mode`, so
  it gets the 302 — which is what makes `curl -sI https://<site>/` a one-line check.
- **A bare 404 `no such preview`** from the bounce host — the `state` did not match either
  pattern. There is no other diagnostic at the edge; check the `state` format first.
- **A 403 with an empty Lambda log** — `cloudfront-origins.md`. Either a missing
  `CfnPermission` (both grants are required) or a `POST` with a body through OAC without
  `x-amz-content-sha256`. The latter is why `/auth/session` is a `GET`.

## Local dev is not gated and cannot be

`pnpm dev` has no CloudFront, so there is no gate and no `/auth/*` endpoint. `AUTH=local` and
the dev-login box are the only way in, and they stay. This is not an oversight to be fixed —
say so before someone "adds the missing local gate".
