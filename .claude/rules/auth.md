---
paths:
  - "packages/cdk-core/src/auth/**"
  - "packages/cdk-core/src/user-pool.ts"
  - "packages/cdk-core/src/config.ts"
  - "apps/api/src/app.ts"
  - "scripts/preview-login.sh"
---

# Auth: two pools, one Google client, and the machine user

Loaded when you touch the auth helpers, the user-pool construct, or the site config. The
distribution and router side is `.claude/rules/cdk.md`; the bounce host lives in the generated
router there. The reasoning is `plan.md` D4–D6.

**When `auth.gate` is `'edge'` the whole site sits behind Google and the browser holds no
Cognito token at all — it holds an HMAC session cookie.** That mechanism is
`.claude/rules/edge-gate.md`; this file stays the description of the *pools*. Both are true at
once: the gate reuses the `browser` app client described here, and `getUser` still accepts an
`x-id-token` from a machine caller.

## The shape

| | prod (`Site.auth`) | preview (`PreviewSite.auth`) |
| --- | --- | --- |
| pool | `CdkCoreSite`, one per site | `CdkCorePreview`, one per site, shared by every PR |
| hosted UI | `cdk-core.auth.us-east-1.amazoncognito.com` | `cdk-core-preview.auth.…` |
| browser client | callback `https://<site>/auth/callback` | callback `https://oauth.preview.<site>/` |
| `state` (SPA flow) | `<nonce>` | `<nonce>.<pr>` |
| `state` (edge gate) | `<iat>.<hexsig>` | `<iat>.<hexsig>~<pr>` |
| other clients | none | `machine`, password flow, no hosted UI |
| native users | **none** | `claude`, password in Secrets Manager |

Both pools trust the **same** Google OAuth client, whose two redirect URIs are the two hosted-UI
domains' `/oauth2/idpresponse`. There is no API to create a Google client — onboarding a site is
a human adding two redirect URIs to the existing one.

## The four things that are load-bearing

1. **`ExplicitAuthFlows` is pinned on the L1, not coaxed out of the L2.** CDK's
   `configureAuthFlows` returns `undefined` for both an absent and an *empty* `authFlows`, and
   an omitted `ExplicitAuthFlows` makes Cognito apply its legacy defaults — which include
   `ALLOW_USER_SRP_AUTH`. So `user-pool.ts` sets
   `cfnClient.explicitAuthFlows = ['ALLOW_REFRESH_TOKEN_AUTH']` directly, and `site.test.ts`
   asserts it. This list is the whole of D6's claim that machine sign-in is *structurally*
   impossible in prod: there is no flag to flip, because the password flow is absent rather
   than disabled. Removing `COGNITO` from `SupportedIdentityProviders` is cosmetic by
   comparison — it hides the box, it does not gate the SDK.
2. **The app client must `addDependency` on the Google IdP.** A client naming `Google` in
   `SupportedIdentityProviders` fails to create if the provider does not exist yet, and
   CloudFormation is free to order them either way. CDK does not infer it.
3. **The Google client id *and* secret are `{{resolve:secretsmanager:…}}` dynamic
   references.** The id is not itself secret, but reading both through the same reference keeps
   the template free of either and means a rotated Google client needs no code change. They
   render as an `Fn::Join` (the partition is a pseudo-parameter), so assert on the serialized
   form, not on a plain string.
4. **`attributeMapping: { email: GOOGLE_EMAIL }` is required.** Without it a federated user has
   no `email` attribute, the ID token carries no `email` claim, and `auth/server` rejects every
   token it successfully verifies — a 401 that looks exactly like a signature failure.

## The browser half

`auth/oidc.ts` is the pure part (PKCE S256, `state`, the two token calls) and is unit-tested in
plain Node; `auth/browser.ts` is the part that touches `window`, `sessionStorage` and
`localStorage`. Keep new logic in `oidc.ts` — a DOM global at module scope makes the whole file
untestable without jsdom, which this repo does not have.

- **The preview `redirect_uri` is the bounce host, not the PR's hostname**, both in the
  authorize redirect and in the token exchange — Cognito requires them to match, and its
  callback list has no wildcards. The router turns `state`'s digits back into
  `pr-<n>.preview.<site>` and only re-forwards query params matching `^[A-Za-z0-9._~-]+$`,
  which is why `state` is `<nonce>.<pr>` and never URL-encoded JSON.
- `sessionStorage['cdkcore:pkce']` holds `{verifier, nonce, returnTo}` and survives the bounce
  because the browser lands back on the origin it started from. The nonce comparison in
  `handleCallback` is the CSRF check.
- Tokens live in `localStorage['cdkcore:auth']` as `{idToken, accessToken, refreshToken?,
  expiresAt}` — **our** key, not Amplify's, which is what lets Playwright seed a session with
  `addInitScript`. Anything that changes this shape changes the e2e fixture and
  `scripts/preview-login.sh` in the same commit.
- Cognito returns **no new `refresh_token`** on the refresh grant, so the old one is carried
  forward. Concurrent `getToken()` callers share one in-flight refresh; a failed refresh logs
  out rather than throwing, because an expired session is not an error the UI should render.

## The server half

`AUTH` decides everything and is read per call, never at module load: `cognito` (the
constructs), `local` (`pnpm dev` only), unset = `none`. In `cognito` mode a missing
`AUTH_ISSUER`/`AUTH_CLIENT_ID` **throws** — that is a deployment bug and must be loud — but a
token that fails verification returns `null`, because an invalid token is an anonymous caller.

Authorization is on the **ID token**, never the access token: `InitiateAuth` access tokens
carry only `aws.cognito.signin.user.admin`, so scopes say nothing. The verifier is cached per
`(issuer, clientId)` for the life of the process — `aws-jwt-verify` caches the JWKS inside the
instance, and a fresh one per request re-fetches it from Cognito every time.

**`AUTH_CLIENT_ID` is a comma-separated list, and a preview passes two.** A token's `aud` is
the app client that minted it, not the pool, so the machine user's tokens carry `machine` and a
human's carry `browser`. A preview API that trusted only `authClientId` would 401 every machine
call — measured, not inferred. Trusting both is safe because the boundary that matters is the
*pool*: the prod verifier's `iss` is a different pool, so it rejects both.

The negative test is the one that proves anything: a **preview** ID token sent to
`https://cdk-core.ty.ler.dev/api/me` must be **401**, because the prod verifier's `iss` is the
prod pool. That, not the 200, is what makes the two pools isolated rather than merely separate.

## The machine user

`PreviewSite` creates it through the `PoolUser` custom resource in the shared handler:
`AdminCreateUser` with `MessageAction: SUPPRESS` (the address is not a mailbox), then
`AdminSetUserPassword --permanent`, which is what moves the user from
`FORCE_CHANGE_PASSWORD` to `CONFIRMED` so `USER_PASSWORD_AUTH` returns tokens rather than a
challenge. The password is **generated by Secrets Manager and read at runtime** — it never
reaches the template, a change set, or a stack event. An existing user is not an error: a stack
update re-runs the resource, and re-setting the password is how a rotated secret takes effect.

The pool's password policy sets `requireSymbols: false` precisely so the generated secret can
use `excludePunctuation: true`. A generated password the policy rejects fails inside a custom
resource, i.e. as a rollback rather than a readable error.

`InitiateAuth` is an **unauthenticated** API, so `scripts/preview-login.sh` and the Playwright
fixture call it with `--no-sign-request` and need no IAM permission for it. They do need
`secretsmanager:GetSecretValue` on `<site>/preview-machine-user`, which is why the deploy role
grants exactly that one secret.
