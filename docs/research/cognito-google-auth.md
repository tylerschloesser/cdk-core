# Cognito + Google + PR-preview auth — verified research

**Research performed: 2026-09-06.** Every claim below is backed by a URL I actually fetched on that
date. Where I could not find a definitive source, I say so explicitly rather than filling the gap
from memory. Prices are the US East (N. Virginia) values shown on the AWS pricing page unless noted.

---

# A. Cognito pricing and limits

## A1. Pricing tiers, free tier, federation cost, per-pool cost, custom-domain cost

**Verdict:** Tier names are confirmed as **Lite / Essentials / Plus** (introduced 2024-11-22).
The free tier is **10,000 MAU/month, per AWS account (or AWS Organization) — not per pool**, and it
applies to **both Lite and Essentials**, not Plus. Google (social) users are billed at the *same*
rate as native users — the separate, much smaller 50-MAU free tier applies only to **SAML/OIDC**
federation, which Google-via-Cognito is **not**. There is **no charge for a user pool merely
existing**, and **no charge for a custom domain**. Essentials is **not** required for social IdP
federation, and **not** required for a custom domain — but **managed login (branding version 2) does
require a plan other than Lite**; the *classic hosted UI* (branding version 1) works on Lite.

### Tiers and the November 2024 change

From <https://aws.amazon.com/about-aws/whats-new/2024/11/new-feature-tiers-essentials-plus-amazon-cognito>:

> "Posted on: Nov 22, 2024"
> "Essentials will be the default tier for new users pools created by customers."

From <https://aws.amazon.com/cognito/pricing/>:

> "**Lite** provides basic user registration, authentication, and management capabilities, including
> social identity and SAML/OIDC provider integration, and password-based authentication. Lite is
> targeted for value-oriented use-cases. It includes all Cognito user pool capabilities (without
> advanced security features) available before November 22, 2024."

> "**Essentials** offers comprehensive and flexible user authentication and access control features…
> It includes all capabilities in Lite along with supporting Managed Login and passwordless login
> options using passkeys, email, or SMS. Essentials also supports customizing access tokens and
> disallowing password reuse."

> "**Plus** is geared toward customers with elevated security needs… risk-based adaptive
> authentication, compromised credentials detection, and exporting user authentication event logs…"

### Free tier — per account, and which tiers get it

From <https://aws.amazon.com/cognito/pricing/>:

> "Amazon Cognito Essentials and Lite have a free tier. The free tier does not automatically expire at
> the end of your 12-month AWS Free Tier term, and it is available to both existing and new AWS
> customers indefinitely. Please note - the free tier pricing isn't available in the AWS GovCloud (US)
> Regions."

> "1. For users who sign in directly via Amazon Cognito or through a social identity provider, Amazon
> Cognito user pools has a free tier of **10,000 monthly active user (MAU) per month per account or
> per AWS organization**. This free tier is applicable for customers that configure their user pools
> to either the Lite or Essentials tier. **There is no free tier for the Plus tier.**"

> "2. For users federated through SAML 2.0 or an OpenID Connect (OIDC) identity provider, Amazon
> Cognito user pools has a free tier of 50 MAUs per month per account or per AWS organization
> regardless of your user pool pricing tier configuration."

> "3. There is no free tier for token requests when Cognito is used for the machine-to-machine use case."

**This is the key answer for your setup:** the 10,000 free MAU is pooled across *all* your user pools
in the account. One pool per site does not multiply your free tier, but with a solo developer's
personal sites you will never approach 10,000 MAU, so per-pool-vs-shared-pool is cost-neutral.

### Rates (above free tier)

- Essentials: `$0.015` per MAU (flat). Worked example on the page: "Price / MAU charged above the
  free tier = $0.015".
- Plus: `$0.020` per MAU, no free tier. "Total number of MAUs billed above the 0 MAU free tier".
- Lite: tiered — the page's own worked example shows "90,000 MAUs x $0.0055 = $495 / 850,000 MAUs x
  $0.0046 = $3,910".
- SAML/OIDC federation MAUs: `$0.015` above the 50-MAU free tier, in every tier.

### Is a Google user billed differently?

**No.** The pricing page repeatedly groups social with direct sign-in:

> "There is separate pricing for users who sign in directly with their credentials from a user pool
> (includes social identity providers) and for users who sign in through an enterprise directory with
> SAML federation."

Google in a Cognito user pool is a *social* IdP, not SAML/OIDC — see the console/API values
`Facebook`, `Google`, `LoginWithAmazon`, `SignInWithApple` listed separately from SAML/OIDC providers
in <https://docs.aws.amazon.com/cognito/latest/developerguide/authorization-endpoint.html>. So Google
users fall under the 10,000 free MAU, at the direct-sign-in rate.

### Is Essentials required for social federation? For a custom domain?

**Social federation: no.** From
<https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-sign-in-feature-plans.html>,
"Features by plan" table:

> "| Sign-in with social, SAML, and OIDC providers | Provide users with the options to sign in
> directly or with their preferred provider. | Lite + Essentials + Plus |"
> "| Login pages | A hosted collection of webpages for authentication. **Managed login is available in
> the Essentials and Plus tiers. The classic hosted UI is available in all feature tiers.** | Lite +
> Essentials + Plus |"

**Managed login (v2) does require non-Lite.** From
<https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_CreateUserPoolDomain.html>,
`ManagedLoginVersion`:

> "Managed login requires that your user pool be configured for any [feature plan] other than `Lite`."

**⚠️ Documentation conflict, flagged explicitly.** The social-IdP page says the opposite of the
feature table: <https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-social-idp.html>
opens with

> "**You must enable managed login to integrate with supported social identity providers.**"

whereas the feature-plan table and the pricing page both list social sign-in as a Lite feature and
say the classic hosted UI is available in all tiers. I could not find a source resolving this. Read
"managed login" in that sentence as loose shorthand for "the hosted sign-in pages" (you do need *a
domain* + hosted pages for social sign-in; you cannot federate through the SDK — see A/C below), but
**do not assume Lite + Google works until you test it**. Given Essentials is the default and the free
tier covers you either way, the safe and cost-free choice here is Essentials.

### Per-pool cost, custom-domain cost

- **No per-pool fee.** All Cognito user pool pricing on <https://aws.amazon.com/cognito/pricing/> is
  MAU-based, M2M-token-based, provisioned-RPS-based, or multi-Region-replication-based. There is no
  line item for pool existence. An idle pool with 0 MAU costs $0.
- **No custom-domain fee.** From
  <https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-assign-domain-prefix.html>:
  > "There isn't a cost difference between the Amazon Cognito domain option and the custom domain
  > option. The only difference is the domain in the web address that you direct your users to."
  The CloudFront distribution Cognito creates is AWS-managed and not separately billed per those docs.
- **ACM certificate is free** for this use. From <https://aws.amazon.com/certificate-manager/pricing/>:
  > "ACM issues certificates at no cost for use with services integrated with ACM."
  (The paid tiers there are for *exportable* certs and ACME certs used outside integrated services.)

---

## A2. Quotas

**Verdict:** Your recall of 100 callback URLs is correct. The number that should change your design is
**custom domains: 4 per Region, non-adjustable.**

All of the following are quoted from the resource-quota tables at
<https://docs.aws.amazon.com/cognito/latest/developerguide/limits.html>
(section "Quotas on resource number and size" → "Amazon Cognito user pools resource quotas"):

| Resource | Quota | Adjustable | Maximum quota |
| --- | --- | --- | --- |
| App clients per user pool | 1,000 | Yes | 10,000 |
| User pools per Region | 1,000 | Yes | 10,000 |
| Identity providers per user pool | 300 | Yes | 1,000 |
| Resource servers per user pool | 25 | Yes | 300 |
| Users per user pool | 40,000,000 | Yes | Contact your account team. |
| Total combined changes in pre token generation Lambda trigger | 5,000 | Yes | Contact your account team. |
| Callback URLs per app client | **100** | **No** | N/A |
| Logout URLs per app client | **100** | **No** | N/A |
| Scopes per resource server | 100 | No | N/A |
| Scopes per app client | 50 | No | N/A |
| **Custom domains per Region** | **4** | **No** | **N/A** |
| Groups to which each user can belong | 100 | No | N/A |
| Groups per user pool | 10,000 | No | N/A |
| Identities linked to a user | 5 | No | N/A |
| Characters in identity provider name | 32 | No | N/A |

Scoping note from the same page:

> "Resource quotas at the AWS account level, like *User pools per Region*, apply to Amazon Cognito
> resources in each AWS Region. For example, you can have 1,000 user pools in US East (N. Virginia)
> and another 1,000 in Europe (Stockholm)."

The 100-callback-URL cap is corroborated in the API reference,
<https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_CreateUserPoolClient.html>,
`CallbackURLs`: "Array Members: Minimum number of 0 items. **Maximum number of 100 items.**
Length Constraints: Minimum length of 1. **Maximum length of 1024.**" — same for `LogoutURLs`.

**Design implication:** "one pool per site, each with `auth.<site>.com`" hits the **4 custom domains
per Region** wall at the 5th site. Options: use the free `*.auth.<region>.amazoncognito.com` prefix
domain for some/all sites; spread pools across Regions; or accept a lower site count. Note the quota
is marked **non-adjustable**, so a support ticket is not a documented remedy.

Token/session validity quotas from the same page ("Amazon Cognito user pools session validity parameters"):

| Token | Quota |
| --- | --- |
| ID token | 5 minutes – 1 day |
| Refresh token | 1 hour – 3,650 days |
| Access token | 5 minutes – 1 day |
| Hosted UI session cookie | 1 hour |
| Authentication session token | 3 minutes – 15 minutes |

---

## A3. Custom domain: requirements, propagation, sharing, `auth.example.com`

**Verdict:** Yes, `auth.example.com` is exactly the recommended shape. ACM cert **must** be in
`us-east-1`. The **parent** domain (`example.com`) must resolve via a real **A record** — an SOA record
is not enough. New custom domains take **up to one hour** to propagate. A custom domain **cannot** be
shared between two user pools — though AWS never states this in one clean sentence; see the caveat.

From <https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-add-custom-domain.html>,
"Prerequisites":

> "A web domain that you own. Its *parent domain* must have a valid DNS **A record**. You can assign
> any value to this record. The parent may be the root of the domain, or a child domain that is one
> step up in the domain hierarchy. For example, if your custom domain is *auth.xyz.example.com*,
> Amazon Cognito must be able to resolve *xyz.example.com* to an IP address. To prevent accidental
> impact on customer infrastructure, Amazon Cognito doesn't support the use of top-level domains
> (TLDs) for custom domains."

> "The ability to create a subdomain for your custom domain. **We recommend `auth` for your subdomain
> name. For example: `auth.example.com`.**"

> "A public SSL/TLS certificate managed by ACM in US East (N. Virginia). **The certificate must be in
> us-east-1** because the certificate will be associated with a distribution in CloudFront, a global
> service."

And the explicit warning about the parent A record:

> "Amazon Cognito verifies that there is a DNS record for the parent domain of your custom domain to
> protect against accidental hijacking of production domains. If you do not have a DNS record for the
> parent domain, Amazon Cognito will return an error when you attempt to set the custom domain. **A
> Start of Authority (SOA) record isn't a sufficient DNS record** for the purposes of parent-domain
> verification."

**Propagation.** From
<https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-assign-domain.html>:

> "It can take Amazon Cognito up to a minute to launch or update the branding version of a prefix
> domain. Changes to a custom domain can take **up to five minutes** to propagate. **New custom
> domains can take up to one hour** to propagate."

Corroborated in the API reference
(<https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_CreateUserPoolDomain.html>):

> "Your prefix domain might take up to one minute to take effect. Your custom domain is online within
> five minutes, but it can take up to one hour to distribute your SSL certificate."

Also: changing the cert later — "After you provide your new certificate, Amazon Cognito requires up to
1 hour to distribute it to your custom domain."

**Can two pools share one custom domain? No — but stated only indirectly.** I could not find a single
AWS sentence saying "a custom domain can belong to only one user pool." The evidence:

1. `DescribeUserPoolDomain` / `DeleteUserPoolDomain` are keyed on the **domain alone**, with no pool
   id — implying a global 1:1 domain→pool mapping. From
   <https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-assign-domain-prefix.html>:
   `aws cognito-idp describe-user-pool-domain --domain <domain_name>`.
2. Cognito provisions a **CloudFront distribution** per custom domain, and CloudFront CNAMEs are
   globally unique: "Amazon Cognito creates a Amazon CloudFront distribution, secured in transit with
   your ACM certificate."
3. AWS's own guidance assumes distinct domains per pool:
   > "You can configure separate user pools to have custom domains in the same top-level domain (TLD),
   > for example *auth.example.com* and *auth2.example.com*."

**Important gotcha for a multi-pool setup** (from the same "Things to know about user pool domains"
section) — do not nest your auth domains:

> "**Don't use custom domains at different levels of your domain hierarchy.** … The managed login
> session cookie is valid for a custom domain and all subdomains, for example *\*.auth.example.com*.
> Because of this, no user of your applications should access managed login for any parent domain
> *and* subdomain. Where custom domains use the same TLD, keep them at the same subdomain level."

So `auth.site-a.com` + `auth.site-b.com` is fine; `auth.example.com` + `uk.auth.example.com` is not.

Other constraints from the same pages worth knowing:

- One prefix domain **and** one custom domain can coexist on a pool, but "Amazon Cognito only serves
  the `/.well-known/openid-configuration` endpoint for the *custom* domain."
- Prefix domain form: `{prefix}.auth.{AWS Region code}.amazoncognito.com`, and "You can't use the text
  `aws`, `amazon`, or `cognito` in the name of an Amazon Cognito prefix domain."
- The discovery endpoints are **not** on your domain — they are at
  `https://cognito-idp.{Region}.amazonaws.com/{userPoolId}/.well-known/openid-configuration` and
  `…/jwks.json`.
- Managed-login custom domains require `SecurityPolicy` ≥ `TLS_V1_2_2021`: "Custom domains that use
  managed login (branding version 2) require a minimum TLS version of `TLS_V1_2_2021` or higher. A
  request that sets `TLS_V1` for a managed login domain returns an `InvalidInputException` error."

---

# B. Google OAuth client

## B4. Exact-match redirect URIs, one client for many pools, URI limits, Testing vs Production

**Verdict:** Confirmed — exact match, no wildcards, no fragments, HTTPS only (localhost exempt).
**Yes, one Google OAuth client can serve multiple Cognito user pools** by listing each pool's
`https://<pool-domain>/oauth2/idpresponse` as a separate authorized redirect URI. Google publishes
**no hard limit on the number of redirect URIs per client**, but it *does* enforce a **10 unique
second-level-domain limit per GCP project** across redirect + origin URLs. Testing mode caps you at
**100 test users**, and its **7-day refresh-token expiry does *not* apply** if you only request
`openid`/`email`/`profile` — which is exactly the Cognito↔Google scope set.

### Exact match / no wildcards

From <https://developers.google.com/identity/protocols/oauth2/web-server>:

> "The value must exactly match one of the authorized redirect URIs for the OAuth 2.0 client, which
> you configured in the API Console."
> "Note that the `http` or `https` scheme, case, and trailing slash ('`/`') must all match."

Redirect URI validation rules (same page, `#uri-validation`):

> **Scheme:** "Redirect URIs must use the HTTPS scheme, not plain HTTP. Localhost URIs (including
> localhost IP address URIs) are exempt from this rule."
> **Host:** "Hosts cannot be raw IP addresses. Localhost IP addresses are exempted from this rule."
> **Userinfo:** "Redirect URIs cannot contain the userinfo subcomponent."
> **Path:** "Redirect URIs cannot contain a path traversal (also called directory backtracking), which
> is represented by an '/..' or '\..' or their URL encoding."
> **Query:** "Redirect URIs cannot contain open redirects."
> **Fragment:** "Redirect URIs cannot contain the fragment component."
> **Characters:** "Redirect URIs cannot contain certain characters including: **Wildcard characters
> (`'*'`)**", non-printable ASCII characters, invalid percent encodings, and null characters.

This is consistent with the spec-level requirement in RFC 9700 §2.1
(<https://www.rfc-editor.org/rfc/rfc9700.txt>):

> "When comparing client redirection URIs against pre-registered URIs, authorization servers MUST
> utilize exact string matching except for port numbers in localhost redirection URIs of native apps."

### One Google client, many Cognito pools

Nothing in Google's docs restricts a web OAuth client to one redirect target; you register a list.
The value Cognito needs per pool is documented at
<https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-social-idp.html>:

> "Under **Authorized JavaScript origins**, choose **ADD URI**. Enter your user pool domain.
> `https://mydomain.auth.us-east-1.amazoncognito.com`"
> "Under **Authorized redirect URIs**, choose **ADD URI**. Enter the path to the `/oauth2/idpresponse`
> endpoint of your user pool domain.
> `https://mydomain.auth.us-east-1.amazoncognito.com/oauth2/idpresponse`"

and for the consent screen:

> "Your **Authorized domains** must include `amazoncognito.com` and the root of your custom domain, for
> example `example.com`."
> "Under **Scopes**, choose **Add or remove scopes**, and choose, at minimum, the following OAuth
> scopes: `.../auth/userinfo.email`, `.../auth/userinfo.profile`, `openid`."

So: add one redirect URI per pool domain, one JS origin per pool domain, and every site's root domain
plus `amazoncognito.com` to Authorized domains. That works in a single client.

**But the practical constraint is the domain cap, not the URI count.** From
<https://support.google.com/cloud/answer/7650096?hl=en> ("Domain Limit Exceeded FAQ"):

> "Some GCP projects have multiple unique domains in the redirect URI and origin URLs, many of which
> have completely unrelated applications. This causes a misrepresentation of your brand's identity to
> your users, and is in direct violation of Google's Terms of Service. To protect the user experience,
> we ask that you use **no more than 10 unique domains of redirect and origin URLs in your projects**."

> "We use the second level domain (SLD) of your redirect URIs and origin URLs when counting the number
> of domains in your project." Examples given: `https://foo.bar.example.com` → `example`;
> `https://myapp.appspot.com` → `myapp`; `http://localhost:8080/callback` → `localhost`.

> "If you need more than 10 unique domains in your redirect URIs and origin URLs, it's best to create
> separate projects that clearly represent the identity that's associated with each of them."

**Reading for your case:** if every pool uses `*.amazoncognito.com` prefix domains, they all collapse
to the single SLD `amazoncognito` — one domain, no limit pressure. If each site uses its own
`auth.<site>.com`, each distinct site domain counts as one SLD, so you can host **~9 personal sites +
localhost** in one Google project. Also note Google's stated policy preference against unrelated apps
sharing a project — one Google project per site is the "correct" shape and only costs you extra
console clicks.

### Max redirect URIs per client

**No published hard limit.** Google's own developer forum answer (2024-10-02) at
<https://discuss.google.dev/t/max-number-of-authorized-redirect-uris/168503>:

> "The OAuth 2.0 doesn't specify a hard limit on the number of redirect URIs per client ID."
> "it's best practice to minimize the number of redirect URIs per Client ID."

I checked <https://support.google.com/cloud/answer/15549257?hl=en> ("Manage OAuth Clients") and it
publishes **no** numeric limit on redirect URIs or JS origins — the only numeric limit stated there is
"You can only have two client secrets at maximum." The widely-repeated "100 redirect URIs" figure is
**not** in Google's documentation as far as I can find; treat it as folklore, and treat the 10-SLD
project limit as the real constraint.

### Testing vs Production consent screen

From <https://support.google.com/cloud/answer/15549945?hl=en> ("Manage App Audience"):

> "Projects configured with a publishing status of **Testing** are limited to **up to 100 test users**"
> "**Authorizations by a test user will expire seven days from the time of consent.**"

User type: **External** = "any user with a Google Account"; **Internal** = restricted to members of
your Google Cloud Organization (so Internal is only available if you have a Workspace/Cloud org).

The important exemption, from <https://developers.google.com/identity/protocols/oauth2>:

> "A Google Cloud Platform project with an OAuth consent screen configured for an external user type
> and a publishing status of 'Testing' is issued a refresh token expiring in 7 days, **unless the only
> OAuth scopes requested are a subset of name, email address, and user profile (through the
> `userinfo.email`, `userinfo.profile`, `openid` scopes, or their OpenID Connect equivalents)**."

Cognito's Google IdP requests exactly `openid`, `userinfo.email`, `userinfo.profile` (per the AWS
social-IdP doc quoted above), **so the 7-day expiry does not bite you.** The 100-test-user cap also
does not bite a personal site with a handful of users. Two other limits from the same page worth
noting:

> "There is currently a limit of **100 refresh tokens per Google Account per OAuth 2.0 client ID**. If
> the limit is reached, creating a new refresh token automatically invalidates the oldest refresh
> token without warning."

Practical conclusion: for personal sites where you and a few friends sign in, **Testing mode is fine
indefinitely** with basic profile scopes. Publishing to Production with only those scopes also does
not require Google verification review (verification is driven by sensitive/restricted scopes), but
I did not fetch a source that states that in those words, so treat that last sentence as unverified.

---

## B5. Can you create Google OAuth clients programmatically?

**Verdict:** **No** — there is no public Google API for creating ordinary (web-app) OAuth 2.0 client
IDs. The only programmatic path is `gcloud iap oauth-clients` / the IAP `identityAwareProxyClients`
API, and the clients it produces are **locked to IAP** and unusable as a Cognito Google IdP. Google's
own docs for standard clients describe only console steps. **Plan on creating the Google OAuth client
by hand in the console, once per site, and feeding client id/secret into your CDK as parameters.**

From <https://docs.cloud.google.com/iap/docs/programmatic-oauth-clients> (note: `cloud.google.com`
301-redirects to `docs.cloud.google.com`):

> "OAuth clients created by the API can only be modified by using the API"
> "**The OAuth clients created by the API are locked for IAP usage only**"
> "Only 500 OAuth clients are allowed per project when using the API"

and on brands: an API-created brand starts **internal** and "must be manually set to public if
desired", after which "the `identityAwareProxyClients.create()` API will stop working". Maximum one
brand per project. Commands shown:

```
gcloud iap oauth-brands list
gcloud iap oauth-brands create --application_title=APPLICATION_TITLE --support_email=SUPPORT_EMAIL
gcloud iap oauth-clients create projects/PROJECT_NUMBER/brands/BRAND-ID --display_name=NAME
```

For standard clients, <https://support.google.com/cloud/answer/15549257?hl=en> ("Manage OAuth Clients")
and <https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-social-idp.html>
both describe only manual console flows ("Choose **CREATE CREDENTIALS**, then **OAuth client ID**").
I found **no** Google API reference for creating a web OAuth client, and no gcloud surface other than
the IAP one. This is a negative result — absence of documentation, not a documented prohibition — but
it matches the IAP page's framing that the API path exists specifically because there is no general one.

**Consequence for your design:** since the Google client is manual, you want the *set of Google
redirect URIs to be stable*. That is precisely the argument for a fixed per-site auth host and a
`state`-based bounce for PR previews (section D) rather than registering a Google redirect URI per PR.

---

# C. Token audience / namespacing within one pool

## C6. `aud` / `client_id`, cross-client validity, shared directory

**Verdict:** Confirmed. ID token `aud` = app client ID; access token carries `client_id` (access
tokens have **no** `aud` claim unless you use resource binding). A token from client A fails
verification at client B **if and only if your verifier checks that claim** — Cognito itself does not
scope-fence the tokens for you. And yes, a user pool is **one shared directory**: any user can sign in
through any app client in the pool that permits the relevant IdP/flow.

From <https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-tokens-verifying-a-jwt.html>:

> "**Payload** — Token claims. In an ID token, the claims include user attributes and information about
> the user pool, `iss`, and app client, `aud`. In an access token, the payload includes scopes, group
> membership, your user pool as `iss`, and **your app client as `client_id`**."

"Verify the claims" steps, verbatim:

> "1. …verify that the token hasn't expired."
> "2. **The `aud` claim in an ID token and the `client_id` claim in an access token must match the app
> client ID that was created in the Amazon Cognito user pool.**"
> "3. The issuer (`iss`) claim must match your user pool. For example, a user pool created in the
> `us-east-1` Region will have the following `iss` value:
> `https://cognito-idp.us-east-1.amazonaws.com/<userpoolID>`."
> "4. Check the `token_use` claim. If you are only accepting the access token in your web API
> operations, its value must be `access`. If you are only using the ID token, its value must be `id`."

And the code sample's comment is emphatic: `clientId: '1example23456789', // you must verify the token audience`.

**Nuance you should not miss:** ID/access tokens from *different app clients in the same pool* are
signed by the **same** user pool signing keys and have the **same** `iss`. Signature + issuer +
expiry all pass across clients. **Only** the `aud`/`client_id` check separates them. So per-app-client
isolation within one pool is real but is entirely enforced by your verifier — it is a convention, not
a cryptographic boundary. If a preview environment's API forgets the `clientId` check, a prod token
validates there and vice versa.

**Shared directory / cross-client sign-in.** From
<https://docs.aws.amazon.com/cognito/latest/developerguide/authorization-endpoint.html> on `prompt=none`:

> "Amazon Cognito silently continues authentication for users who have a valid authenticated session.
> With this prompt, **users can silently authenticate between different app clients in your user
> pool.**"

And from <https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-client-apps.html>:

> "You can create multiple apps for a user pool. An app client might be linked to the code platform of
> an app, **or a separate tenant in your user pool**. … Each app has its own app client ID."

So one pool per site, one app client per environment (prod, and one per PR preview or one shared
preview client) is a supported "tenant" pattern — with the caveat above that isolation lives in your
verifier.

**Also relevant:** access tokens *can* be given a real `aud` via resource binding (RFC 8707) if you
want a stronger audience story:

> "**`resource`** — Optional. The identifier of a resource that you want to bind to the access token in
> the `aud` claim. … Amazon Cognito validates that the value is a URL and sets the audience of the
> resulting access token to the requested resource."
> "You can only bind access tokens to resources for users. **You can't request a resource binding with
> client-credentials M2M grants.**"
> "This feature is exclusive to managed login authentication … It is not currently available in SDK
> authentication models."

---

## C7. Per-app-client callback URLs / IdP list / scopes; `aws-jwt-verify` with multiple client ids

**Verdict:** Yes to all three — callback URLs, supported IdPs, OAuth scopes, OAuth grant types, token
lifetimes, and auth flows are **all per-app-client**. `aws-jwt-verify`'s `clientId` accepts a string,
an array of strings, or `null`.

From <https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-client-apps.html>:

> "You can apply settings for the following user pool features at the app client level: … Managed login
> **IdPs, grant types, callback URLs, and customization**; Resource servers and custom scopes; Threat
> protection; Attribute read and write permissions; **Token expiration and revocation**;
> **Authentication flows**."

> "**Identity providers** — You can choose some or all of your user pool external identity providers
> (IdPs) to authenticate your users. Your app client can also authenticate only local users in your
> user pool. … **You can assign multiple IdPs, but you must assign at least one.**"

> "**Allowed callback URLs** — A callback URL indicates where the user will be redirected after a
> successful sign-in. **Choose at least one callback URL.** The callback URL must: Be an absolute URI.
> Be pre-registered with a client. Not include a fragment component. … Amazon Cognito requires `HTTPS`
> over `HTTP` except for `http://localhost` for testing purposes only. App callback URLs such as
> `myapp://example` are also supported."

`AllowedOAuthScopes` is likewise a per-client array (max 50 items) per
<https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_CreateUserPoolClient.html>.

Also useful for a shared-callback design — `DefaultRedirectURI`:

> "**Default redirect URI** — Replaces the `redirect_uri` parameter in authentication requests for users
> with third-party IdPs. … This URL must also be a member of the `CallbackURLs` for your app client.
> Amazon Cognito redirects authenticated sessions to this URL when: 1. Your app client has one identity
> provider assigned and multiple callback URLs defined. Your user pool redirects authentication
> requests … to the default redirect URI when they don't include a `redirect_uri` parameter."

### aws-jwt-verify

From <https://raw.githubusercontent.com/awslabs/aws-jwt-verify/main/README.md> (line 228, verbatim):

> "- `clientId` (mandatory): verify that the JWT's `aud` (id token) or `client_id` (access token) claim
> matches your expectation. **Provide a string, or an array of strings to allow multiple client ids
> (i.e. one of these client ids must match the JWT).** Set to `null` to skip checking client id (not
> recommended unless you know what you are doing)."

The same wording appears again at line 496 for the access-token verifier. For multiple user pools:

```js
const idTokenVerifier = CognitoJwtVerifier.create([
  { userPoolId: "<user_pool_id>",   tokenUse: "id", clientId: "<client_id>" },
  { userPoolId: "<user_pool_id_2>", tokenUse: "id", clientId: "<client_id_2>" },
]);
```

with the README noting "clientId is mandatory at verifier level now, to disambiguate between User
Pools". aws-jwt-verify is the library AWS itself recommends
(<https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-tokens-verifying-a-jwt.html>:
"In a Node.js app, AWS recommends the aws-jwt-verify library…").

**Behavior difference to be aware of:** passing an array means "any of these" — it does **not** tell you
*which* client the token came from. If a preview API must reject prod tokens (or vice versa), pass the
single expected client id, not the array. Use the array only where you genuinely accept several.

---

## C8. Groups and custom claims via pre-token-generation Lambda

**Verdict:** ID-token customization (`V1_0`) works on **all** feature plans including Lite. **Access-token**
customization (`V2_0`) and M2M access-token customization (`V3_0`) require **Essentials or Plus** —
with a legacy grandfather clause for old Lite+ASF pools. Groups (`cognito:groups`) land in **both** ID
and access tokens and can be overridden even by `V1_0`. There is a hard cap of 5,000 combined claim
changes.

From <https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-lambda-pre-token-generation.html>:

> "With the **Basic features** of the version one or `V1_0` pre token generation trigger event, you can
> customize the identity (ID) token. **In user pools with the Essentials or Plus feature plan**, you can
> generate the version two or `V2_0` trigger event with access token customization, and the version
> three or `V3_0` trigger event with access token customization for machine-to-machine (M2M)
> authorization, including both client-credentials grants and the `GetClientToken` API operation."

> "**Event versions one, two, and three are available in the Essentials and Plus feature plans.** M2M
> operations for version three events have a pricing structure separate from the monthly active users
> (MAU) formula."

> "**Note:** User pools that were operational with the **Advanced security features** option on or before
> **November 22, 2024 at 1800 GMT**, and that remain on the **Lite** feature tier have access to event
> versions one and two … User pools in this legacy tier *without* advanced security features have
> access to event version one. **Version three is *only* available in Essentials and Plus.**"

Confirmed against the feature-plan table
(<https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-sign-in-feature-plans.html>):

> "| Customize access token scopes and claims at runtime | Use a Lambda trigger to extend the
> authorization capabilities of user pool access tokens | **Essentials + Plus** |"
> "| Customize ID token scopes and claims at runtime | … | **Lite + Essentials + Plus** |"

What you can and cannot touch (from the claims table):

- **Can add/modify:** any claim not in the pool token schema (both tokens); `scope` (access token,
  v2/v3 only); `cognito:groups` (ID **and** access); `cognito:preferred_role`, `cognito:roles` (ID);
  standard OIDC attributes and `custom:` attributes (ID).
- **Cannot touch:** `sub`, `aud`, `client_id`, `iss`, `exp`, `iat`, `token_use`, `cognito:username`,
  `identities`, `username` (access), `event_id`, `device_key`, `origin_jti`, `jti`, `nonce`, `azp`,
  `acr`, `amr`, `at_hash`, `auth_time`, `nbf`, `version`, or any other `cognito:`-prefixed claim.
- Special case: "You can add an `aud` claim to access tokens, but its value **must match the app client
  ID of the current session**. You can derive the client ID in the request event from
  `event.callerContext.clientId`."

Quota (from the limits page): "Total combined changes in pre token generation Lambda trigger | 5,000 |
Yes | Contact your account team." with the footnote "The number of existing and added claims plus
scopes in access and identity tokens in one transaction must add up to a number smaller than or equal
to this quota."

Trigger sources include `TokenGeneration_HostedAuth`, `TokenGeneration_Authentication`,
`TokenGeneration_RefreshTokens`, and `TokenGeneration_ClientCredentials` ("Your user pool only sends
this event when your event version is V3_0").

**For your use case** — tagging a token with "this is a preview user" or "this user may only access
PR-123" — an ID-token custom claim via `V1_0` is free on any plan; adding a `scope` to the access
token requires Essentials. Cognito **groups** are the cheapest mechanism and work everywhere:
`cognito:groups` is already in both tokens with no Lambda at all.

---

# D. Shared callback + OAuth `state` bounce

## D9. Is `state` passed through opaquely? Size? PKCE?

**Verdict:** Yes, `state` is echoed back verbatim to `redirect_uri` on both success and error. Cognito
documents **no** byte limit, but it does document **one format restriction**: you may not pass a
URL-encoded JSON string. PKCE is supported, **S256 only** (`plain` is rejected).

From <https://docs.aws.amazon.com/cognito/latest/developerguide/authorization-endpoint.html>:

> "**`state`** — Optional, recommended. When your app adds a *state* parameter to a request, **Amazon
> Cognito returns its value to your app when the `/oauth2/authorize` endpoint redirects your user.**
> Add this value to your requests to guard against CSRF attacks. **You can't set the value of a `state`
> parameter to a URL-encoded JSON string. To pass a string that matches this format in a `state`
> parameter, encode the string to base64, then decode it in your app.**"

Echoed on success:

```
HTTP/1.1 302 Found
Location: https://www.example.com?code=a1b2c3d4-5678-90ab-cdef-EXAMPLE11111&state=abcdefg
```

…and on error, which matters for your bounce design:

```
HTTP/1.1 302 Found Location: https://www.example.com?error=login_required&state=abcdefg
```

**Size: undocumented.** I searched and could not find any AWS-published maximum length for `state`.
The practical ceiling is total URL length through the browser → Cognito → CloudFront → Google →
Cognito → your callback chain; a real-world Amplify issue exists about oversized `state`
(<https://github.com/aws-amplify/amplify-js/issues/9361>), but that is a community report, not a
documented limit. **Recommendation: keep `state` small** — a random opaque id plus a short
base64url-encoded payload, or better, a random id that keys a short-lived server-side record holding
the return URL. That also sidesteps the URL-encoded-JSON restriction entirely.

PKCE, from the same page:

> "**`code_challenge_method`** — Optional. The hashing protocol that you used to generate the
> challenge. The PKCE RFC defines two methods, S256 and plain; however, **Amazon Cognito
> authentication server supports only S256.**"
> "**`code_challenge`** — Optional. The proof of key code exchange (PKCE) challenge that you generated
> from the `code_verifier`. … Required only when you specify a `code_challenge_method` parameter."

And the failure mode: "The value of the `code_challenge_method` parameter isn't `S256`" produces
`HTTP 1.1 302 Found Location: https://client_redirect_uri?error=invalid_request`.

AWS's own best-practice note (from the app-client page):

> "As a best security practice in public-client apps, activate only the authorization-code grant OAuth
> flow, and implement Proof Key for Code Exchange (PKCE) to restrict token exchange."

Other authorize-endpoint parameters useful to a preview-environment design:
`identity_provider=Google` (skip the chooser and go straight to Google), `login_hint`, and
`prompt=none|login|select_account|consent`.

---

## D10. Wildcard callback URLs?

**Verdict:** **No wildcard support.** Callback URLs must be pre-registered and matched exactly.
`http://localhost` (and `http://127.0.0.1`, `http://[::1]`) are the only HTTP exceptions.

From <https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_CreateUserPoolClient.html>,
`CallbackURLs`:

> "A redirect URI must meet the following requirements: Be an absolute URI. **Be registered with the
> authorization server. Amazon Cognito doesn't accept authorization requests with `redirect_uri` values
> that aren't in the list of `CallbackURLs` that you provide in this parameter.** Not include a fragment
> component."
> "**Amazon Cognito requires HTTPS over HTTP except for callback URLs to `http://localhost`,
> `http://127.0.0.1` and `http://[::1]`. These callback URLs are for testing purposes only. You can
> specify custom TCP ports for your callback URLs.** App callback URLs such as `myapp://example` are
> also supported."

There is **no** `*`, prefix-match, or subdomain-match feature anywhere in the CreateUserPoolClient /
UpdateUserPoolClient API surface or the app-client documentation. So `https://pr-*.preview.example.com/callback`
is not expressible.

**However** — you have 100 callback URLs per app client (A2). For a personal project, registering PR
preview callbacks *directly* is viable if PR numbers are bounded and you prune: 100 slots is a lot.
The genuine blocker is not Cognito, it's **Google**: adding `https://pr-123.preview.example.com/...`
to Google is unnecessary (Google only ever sees the Cognito `/oauth2/idpresponse` URI), so actually
**Google does not constrain your per-PR callbacks at all**. Re-check your premise: the Google redirect
URI list only needs the *Cognito domain*, one entry per pool, forever stable. The exact-match problem
is **Cognito-side only**, and Cognito callbacks are updatable via `UpdateUserPoolClient` from CI with
no manual console step.

That gives you two workable designs:

- **(a) Dynamic registration.** CI calls `UpdateUserPoolClient` to add `https://pr-123.preview.example.com/auth/callback`
  to a dedicated preview app client on PR open, and removes it on PR close. Requires read-modify-write
  of the full client config (the docs warn: "Prepare an `UpdateUserPoolClient` request with your
  existing user pool settings from a `DescribeUserPoolClient` request. **Your `UpdateUserPoolClient`
  request must include all existing app client properties.**"), and is racy if several PRs update at
  once (`ConcurrentModificationException` exists on these APIs). Capped at 100 live previews.
- **(b) The bounce.** One fixed callback `https://preview.example.com/auth/callback`, return URL
  carried in `state`, allowlist-validated, then a second redirect to `https://pr-123.preview.example.com/...`.
  No API writes from CI, no cap, no race. See D11 for how to do this safely.

(b) is the better fit, and the security literature agrees on how to do it.

---

## D11. Best practice for a bounce redirect

**Verdict:** The bounce is a *deliberately built open redirector* unless you constrain it. The
governing spec is **RFC 9700 / BCP 240, "Best Current Practice for OAuth 2.0 Security" (January 2025)**,
which says clients **MUST NOT** expose open redirectors and, if `state` carries application state,
clients **MUST** protect `state` against tampering and swapping.

RFC 9700 metadata, from <https://datatracker.ietf.org/doc/rfc9700/>:

> Title: "Best Current Practice for OAuth 2.0 Security" · Status: **BCP 240** · Published: **January 2025**
> Abstract: "This document describes best current security practice for OAuth 2.0. It updates and
> extends the threat model and security advice given in RFCs 6749, 6750, and 6819…"

§2.1, verbatim (<https://www.rfc-editor.org/rfc/rfc9700.txt>):

> "Clients and authorization servers **MUST NOT expose URLs that forward the user's browser to
> arbitrary URIs obtained from a query parameter (open redirectors)** as described in Section 4.11.
> Open redirectors can enable exfiltration of authorization codes and access tokens."

§4.11 intro — note that it names your exact use case as the motivating example:

> "The following attacks can occur when an authorization server or client has an open redirector. Such
> endpoints are sometimes implemented, for example, to show a message before a user is then redirected
> to an external website, **or to redirect users back to a URL they were intending to visit before
> being interrupted, e.g., by a login prompt.**"

§4.11.1 "Client as Open Redirector", verbatim:

> "**Clients MUST NOT expose open redirectors.** Attackers may use open redirectors to produce URLs
> pointing to the client and utilize them to exfiltrate authorization codes and access tokens…
> Another abuse case is to produce URLs that appear to point to the client. This might trick users into
> trusting the URL and following it in their browser. This can be abused for phishing."
> "**In order to prevent open redirection, clients should only redirect if the target URLs are allowed
> or if the origin and integrity of a request can be authenticated.** Countermeasures against open
> redirection are described by OWASP."

§4.7.1 "Countermeasures" (CSRF + state integrity), verbatim:

> "The long-established countermeasure is that clients pass a random value, also known as a CSRF Token,
> in the state parameter that links the request to the redirection URI to the user agent session…
> The same protection is provided by PKCE or the OpenID Connect nonce value."
> "**If state is used for carrying application state, and the integrity of its contents is a concern,
> clients MUST protect state against tampering and swapping. This can be achieved by binding the
> contents of state to the browser session and/or by signing/encrypting state values.**"

RFC 9700 supersedes/extends the older RFC 6819 threat model referenced above (RFC 6819 §5.3.5 is cited
by 9700 as the source of the CSRF-token-in-state countermeasure).

### Concrete recipe for `pr-123.preview.example.com`

1. Bounce host is a **single fixed** callback registered on a **preview-only app client**, e.g.
   `https://preview.example.com/auth/callback`. Prod's app client never lists it.
2. `state` = a random 128-bit id. Store `{return_url, pkce_verifier, nonce, created_at}` server-side
   (DynamoDB with TTL) keyed by that id, **or** sign/encrypt a compact payload — RFC 9700 §4.7.1
   accepts either. Do **not** put a raw return URL in an unsigned `state`.
3. On callback: look up / verify `state`, then validate the return URL against a **strict allowlist
   regex** — anchored, e.g. `^https://pr-\d+\.preview\.example\.com(/[^\s]*)?$`. Reject anything else
   with an error page, never a redirect. Beware `\.` (a literal dot, not `.`), scheme pinning, no
   userinfo (`@`), no `\` or `%5C`, no protocol-relative `//evil.com`.
4. Exchange the code at `/oauth2/token` **from the bounce host** with PKCE `S256`, then hand the
   session to the PR host over a **one-time, short-TTL (≤30 s), single-use** handoff code in the final
   redirect — not the tokens themselves in the URL. The PR host redeems it server-side for its own
   cookie. This avoids tokens ever appearing in a URL/Referer/history.
5. Delete the `state` record on first use (single-use), and bind it to the browser via a
   `SameSite=Lax`, `Secure`, `HttpOnly` cookie set on the bounce host before the redirect to Cognito.
6. Cookie scoping: set the bounce cookie on `preview.example.com` so it is visible to `*.preview.example.com`
   only if you intend that; otherwise scope to the exact host. Remember Cognito's own warning about
   managed-login session cookies on `*.auth.example.com` (A3) — keep the auth domain out of your app
   domain's subtree if you can.

---

# E. Machine auth for automated agents

## E12. `USER_PASSWORD_AUTH`, admin-created user with a permanent password, native ⟷ federated coexistence

**Verdict:** All confirmed. Enable `ALLOW_USER_PASSWORD_AUTH` in the app client's `ExplicitAuthFlows`,
then `InitiateAuth` with `AuthFlow: USER_PASSWORD_AUTH`. Create the user with `AdminCreateUser`
(`MessageAction: SUPPRESS` to send no email), then `AdminSetUserPassword --permanent` to move them
straight to `CONFIRMED`. Native and federated users **do** coexist in one pool.
**Critically: `SupportedIdentityProviders` does *not* need to contain `COGNITO` for
`USER_PASSWORD_AUTH` to work — and removing `COGNITO` does *not* disable it.** The thing that
structurally disables it is **omitting `ALLOW_USER_PASSWORD_AUTH` from `ExplicitAuthFlows`**.

### Enabling the flow

From <https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_CreateUserPoolClient.html>,
`ExplicitAuthFlows`:

> "**If you don't specify a value for `ExplicitAuthFlows`, your app client supports
> `ALLOW_REFRESH_TOKEN_AUTH`, `ALLOW_USER_SRP_AUTH`, and `ALLOW_CUSTOM_AUTH`.**"
> "`ALLOW_USER_PASSWORD_AUTH`: Enable user password-based authentication. In this flow, Amazon Cognito
> receives the password in the request instead of using the SRP protocol to verify passwords."
> "`ALLOW_ADMIN_USER_PASSWORD_AUTH`: Enable admin based user password authentication flow
> `ADMIN_USER_PASSWORD_AUTH`. …"
> Valid Values: `ADMIN_NO_SRP_AUTH | CUSTOM_AUTH_FLOW_ONLY | USER_PASSWORD_AUTH |
> ALLOW_ADMIN_USER_PASSWORD_AUTH | ALLOW_CUSTOM_AUTH | ALLOW_USER_PASSWORD_AUTH | ALLOW_USER_SRP_AUTH |
> ALLOW_REFRESH_TOKEN_AUTH | ALLOW_USER_AUTH`

Note the default: **an app client created without `ExplicitAuthFlows` already allows SRP and custom
auth.** If you want prod to have *no* password path at all, set `ExplicitAuthFlows` explicitly to
`["ALLOW_REFRESH_TOKEN_AUTH"]` (plus whatever you need); do not rely on the default.

Also, `ALLOW_USER_AUTH` (choice-based) "can do username-password and SRP authentication without other
`ExplicitAuthFlows` permitting them" and "To activate this setting, your user pool must be in the
Essentials tier or higher" — so don't enable `ALLOW_USER_AUTH` on prod either, or you reopen the door.

Flow table from <https://docs.aws.amazon.com/cognito/latest/developerguide/authentication.html>:

> "| Sign-in with persistent passwords | Client-side | Sign in with username and password |
> ALLOW_USER_PASSWORD_AUTH |"

and:

> "When you sign users in, the body of your `InitiateAuth` or `AdminInitiateAuth` request must include
> an `AuthFlow` parameter."

### Creating the agent user

From <https://docs.aws.amazon.com/cognito/latest/developerguide/how-to-create-user-accounts.html>:

> "Create new users and automatically confirm their accounts, verify their email addresses, or verify
> their phone numbers."
> "[Suppress] the sending of the invitation message when the user is created."
> (console step: "To suppress the invitation message, choose **Don't send an invitation**." — the API
> equivalent is `MessageAction: SUPPRESS` on `AdminCreateUser`.)
> "**When you set a permanent password for an administrator-created user, their status changes to
> `CONFIRMED` and your user pool doesn't prompt them for a new password *or* required attributes at
> their first sign-in.**"

From <https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_AdminSetUserPassword.html>:

> "Sets the specified user's password in a user pool. This operation administratively sets a temporary
> or permanent password for a user. **With this operation, you can bypass self-service password changes
> and permit immediate sign-in with the password that you set. To do this, set `Permanent` to `true`.**"
> "If the password is temporary, the user's `Status` becomes `FORCE_CHANGE_PASSWORD`. … **After the user
> sets a new password, or if you set a permanent password, their status becomes `Confirmed`.**"
> "**`Permanent`** — Set to `true` to set a password that the user can immediately sign in with."

Sample request from that page:

```json
{ "Password": "MyExamplePassword1=", "UserPoolId": "us-west-2_EXAMPLE",
  "Username": "testuser", "Permanent": true }
```

CLI equivalents:
```
aws cognito-idp admin-create-user --user-pool-id <id> --username agent \
    --message-action SUPPRESS --user-attributes Name=email,Value=agent@example.invalid Name=email_verified,Value=true
aws cognito-idp admin-set-user-password --user-pool-id <id> --username agent --password '<pw>' --permanent
aws cognito-idp initiate-auth --client-id <preview-client-id> --auth-flow USER_PASSWORD_AUTH \
    --auth-parameters USERNAME=agent,PASSWORD='<pw>'
```

### Do native and federated users coexist?

Yes. From the `AdminSetUserPassword` page:

> "`AdminSetUserPassword` can set a password for the user profile that Amazon Cognito creates for
> **third-party federated users**. When you set a password, the federated user's status changes from
> `EXTERNAL_PROVIDER` to `CONFIRMED`. A user in this state can sign in as a federated user, and
> initiate authentication flows in the API like a linked native user. … **As a best security practice
> and to keep users in sync with your external IdP, don't set passwords on federated user profiles.**"

So: one pool holds Google-federated profiles *and* native username/password profiles. Your agent user
should be a **separate native user**, never a password added onto a Google profile.

### Does `SupportedIdentityProviders` need `COGNITO`?

**No — and this is the single most important finding for your "structurally absent from prod"
requirement.** From
<https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_CreateUserPoolClient.html>,
`SupportedIdentityProviders`:

> "A list of provider names for the identity providers (IdPs) that are supported on this client. The
> following are supported: `COGNITO`, `Facebook`, `Google`, `SignInWithApple`, and `LoginWithAmazon`…"
> "**This parameter sets the IdPs that managed login will display on the login page for your app
> client. The removal of `COGNITO` from this list doesn't prevent authentication operations for local
> users with the user pools API in an AWS SDK. The only way to prevent SDK-based authentication is to
> block access with an AWS WAF rule.**"

**Read that carefully.** `SupportedIdentityProviders: ["Google"]` is a *UI* setting. If the app client
has `ALLOW_USER_PASSWORD_AUTH` (or the default `ALLOW_USER_SRP_AUTH`), an SDK caller can still sign in
a native user through it. So:

**Recommended structure for "absent from prod":**
- Prod app client: `SupportedIdentityProviders: ["Google"]`, `ExplicitAuthFlows: ["ALLOW_REFRESH_TOKEN_AUTH"]`
  (explicitly — not defaulted), no `ALLOW_USER_AUTH`, no `ALLOW_USER_SRP_AUTH`.
- Preview app client (separate client id, only created in preview stacks): adds
  `ALLOW_USER_PASSWORD_AUTH`.
- Agent user: create the native user **only in the preview stack** — ideally a **separate user pool**
  for previews. Since the free tier is per-account (A1) and a pool costs nothing to exist (A1), a
  dedicated preview pool costs $0 and gives you a real boundary rather than a config-flag boundary.
  With a separate pool, the prod verifier's `iss` check rejects preview tokens outright — a much
  stronger guarantee than the `aud` check discussed in C6.

Two more relevant facts:
- Federation is **not** available via the SDK at all — from
  <https://docs.aws.amazon.com/cognito/latest/developerguide/authentication.html>:
  > "**You can't sign users in through third-party IdPs in authentication with AWS SDKs.** You must
  > implement managed login or the classic hosted UI, redirect to IdPs, and then process the resulting
  > authentication object with OIDC libraries in your application."
  This is precisely why the agent needs a native user: there is no headless Google path.
- Lockout on bad passwords: "After five failed sign-in attempts with a user's password … Amazon Cognito
  locks out your user for one second. The lockout duration then doubles after each additional one
  failed attempt, up to a maximum of approximately 15 minutes." Don't let a flaky test loop retry.

---

## E13. Client credentials grant — requirements, limitations, and M2M cost

**Verdict:** Requires a **resource server + custom scopes**, an app client **with a secret**, and
`client_credentials` as the **only** allowed OAuth flow. Tokens have **no user** and **no ID token**.
It **cannot** be used with the hosted UI. **M2M token requests are billed separately and have no free
tier** — but there is **no per-app-client charge**. There is also a newer, **domain-free** alternative,
`GetClientToken` + `ALLOW_CLIENT_TOKEN_AUTH`.

From <https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-client-apps.html>:

> "**Client credentials grant** — The client credentials grant is for machine-to-machine (M2M)
> communications. … **You can only activate client-credentials grants in app clients that have a client
> secret and that don't support authorization-code or implicit grants.** As an alternative that requires
> no user pool domain, an app client with a client secret and the `ALLOW_CLIENT_TOKEN_AUTH`
> authentication flow can obtain M2M access tokens with the `GetClientToken` API operation."
> "**Because you don't invoke the client credentials flow as a user, this grant can only add *custom*
> scopes to access tokens.** A custom scope is one that you define for your own resource server.
> Default scopes like `openid` and `profile` don't apply to nonhuman users."
> "**Because ID tokens are a validation of user attributes, they aren't relevant to M2M communication,
> and a client credentials grants doesn't issue them.**"
> "**Client credentials grants add costs to your AWS bill.**"

> "Your app client must have a client secret to perform `client_credentials` grants."

And from `CreateUserPoolClient`, `AllowedOAuthFlows`:

> "**To create an app client that generates client credentials grants, you must add `client_credentials`
> as the only allowed OAuth flow.**"

From <https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-define-resource-servers.html>:

> "An application that accesses an API with M2M authorization must have a client ID and client secret.
> In your user pool, build an app client that has a client secret. Your machine identity can then obtain
> an M2M access token in one of two ways: it can request a *client credentials grant* from the Token
> endpoint, or it can call the `GetClientToken` API operation. **Both approaches issue an access token
> that authorizes only custom scopes from resource servers.** They differ in setup: the token endpoint
> requires a user pool domain and suits applications that use an OIDC library, while `GetClientToken`
> requires no domain and works through the AWS SDK, AWS CLI, or API."

`GetClientToken` setup, verbatim:

> "To use `GetClientToken`, configure an app client that has a client secret and **only** the
> `ALLOW_CLIENT_TOKEN_AUTH` authentication flow. **This flow is mutually exclusive with user
> authentication flows.**"

```
aws cognito-idp create-user-pool-client --user-pool-id us-west-2_EXAMPLE \
    --client-name my-m2m-client --generate-secret \
    --explicit-auth-flows ALLOW_CLIENT_TOKEN_AUTH \
    --allowed-o-auth-scopes "solar-system-data/asteroids.add"
aws cognito-idp get-client-token --client-id 1example23456789 \
    --secret exampleClientSecret123EXAMPLE --scopes "solar-system-data/asteroids.add"
```

Also: "**You can't request a resource binding with client-credentials M2M grants.**"

### M2M pricing

From <https://aws.amazon.com/cognito/pricing/>:

> "3. **There is no free tier for token requests when Cognito is used for the machine-to-machine use
> case.**"

> "Amazon Cognito supports machine-to-machine (M2M) use cases using the OAuth 2.0 specification's
> client credentials flow. … **Amazon Cognito charges you monthly per successful token response. There
> is no additional charge for the number of app clients you have registered in your account.**"

Tiering: "Tier 1: 1 – 250,000 … per 1000 token requests; Tier 2: 250,001 – 5,000,000 …; Tier 3:
5,000,001 and above …" The page's worked example gives the effective rate:

> "Example 1: You have 10 app clients and each client makes 500 requests a month. Your account is in US
> East (N. Virginia) Region … 500 requests x 10 app clients = 5,000 monthly token requests …
> **$0.00225 x 5,000 token requests = $11.25 per month for token requests**"

(i.e. **$0.00225 per token request = $2.25 per 1,000** at Tier 1, single-Region; the multi-Region
examples show **$0.002925**.) Also on the page: "\* Please contact your account team if you require over
2,500 app clients."

**Correction to your recollection:** the Nov-2024 change did introduce separate M2M billing, but the
current page explicitly states there is **no per-app-client charge** — only per successful token
response. M2M is listed as an "Add-on" available in **all three** tiers, per the Compare Tiers table
("Machine-to-machine authorization | Add-on | Add-on | Add-on").

**Is client credentials right for your Playwright agent? Probably not.** The agent needs to act *as a
browser user* — it needs a session in the web app, group membership, a `sub`, ID-token claims. Client
credentials gives you a userless token with custom scopes only, no ID token, and cannot drive managed
login. `USER_PASSWORD_AUTH` with a dedicated native user (E12) is the correct tool. Client credentials
is the right tool only if the agent talks to your API directly, never through the browser session.

---

## E14. Can Playwright seed tokens into browser storage? Two patterns.

**Verdict:** Yes, both patterns work. Seeding `localStorage` is real and the key format is stable in
practice — but it is a **library-internal format, not a public API**. The httpOnly-cookie pattern is
strictly more robust and is what I'd recommend for an automated agent.

### Pattern A — seed `localStorage` with tokens from `InitiateAuth`

Both the legacy `amazon-cognito-identity-js` and Amplify v6 use the **same** key shape.

`amazon-cognito-identity-js@6.3.20`, `src/CognitoUser.js` (npm tarball, verified 2026-09-06):

```js
this.keyPrefix = `CognitoIdentityServiceProvider.${this.pool.getClientId()}`;   // line 91
const idTokenKey     = `${keyPrefix}.${this.username}.idToken`;                 // line 1513
const accessTokenKey = `${keyPrefix}.${this.username}.accessToken`;             // line 1514
const refreshTokenKey= `${keyPrefix}.${this.username}.refreshToken`;            // line 1515
const clockDriftKey  = `${keyPrefix}.${this.username}.clockDrift`;              // line 1516
const lastUserKey    = `${keyPrefix}.LastAuthUser`;                             // line 1517
```

and `src/StorageHelper.js` confirms the default store is `window.localStorage` with an in-memory
fallback:

```js
this.storageWindow = window.localStorage;
this.storageWindow.setItem('aws.cognito.test-ls', 1);
this.storageWindow.removeItem('aws.cognito.test-ls');
```

`@aws-amplify/auth@6.20.0`, `dist/esm/providers/cognito/tokenProvider/TokenStore.mjs`:

```js
const AUTH_KEY_PREFIX = 'CognitoIdentityServiceProvider';                  // constants.mjs
// getAuthKeys():
createKeysForAuthStorage(AUTH_KEY_PREFIX, `${this.authConfig.Cognito.userPoolClientId}.${lastAuthUser}`);
// getLastAuthUserKey():
return `${AUTH_KEY_PREFIX}.${identifier}.LastAuthUser`;
// key builder:
keys.reduce((acc, authKey) => ({ ...acc, [authKey]: `${prefix}.${identifier}.${authKey}` }), {});
```

with key names `accessToken`, `idToken`, `refreshToken`, `clockDrift`, `signInDetails`, `deviceKey`,
`deviceGroupKey`, `randomPasswordKey`, `oauthMetadata`. And `@aws-amplify/core@6.18.0`
`dist/esm/storage/DefaultStorage.mjs` confirms the default is localStorage:

```js
class DefaultStorage extends KeyValueStorage {
    constructor() { super(getLocalStorageWithFallback()); }
}
```

**So the concrete Playwright recipe is:**

```
tokens = InitiateAuth(USER_PASSWORD_AUTH, agent user, preview app client)
page.addInitScript(() => {
  const p = `CognitoIdentityServiceProvider.${CLIENT_ID}`;
  localStorage.setItem(`${p}.LastAuthUser`, USERNAME);
  localStorage.setItem(`${p}.${USERNAME}.idToken`,      tokens.IdToken);
  localStorage.setItem(`${p}.${USERNAME}.accessToken`,  tokens.AccessToken);
  localStorage.setItem(`${p}.${USERNAME}.refreshToken`, tokens.RefreshToken);
  localStorage.setItem(`${p}.${USERNAME}.clockDrift`,   '0');
})
```

**Caveats you must plan for:**
1. `CLIENT_ID` in the key must be the **same app client** the browser app is configured with, and the
   same one used for `InitiateAuth`. If preview uses a different client than the one Playwright
   authenticated against, the app won't find the tokens.
2. The key format is **undocumented internals**. It has been stable across `amazon-cognito-identity-js`
   v6 and Amplify v6, but AWS does not promise it. Pin your Amplify version, or don't use Amplify.
3. **Scope difference — this bites people.** From
   <https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-define-resource-servers.html>:
   > "Because they are designed for human-interactive authentication with the user pool as the IdP,
   > `InitiateAuth` and `AdminInitiateAuth` requests **only produce a `scope` claim in the access token
   > with the single value `aws.cognito.signin.user.admin`**."
   So a token minted via `InitiateAuth` has **none** of the OAuth scopes (`openid`, `email`, custom
   scopes) that a hosted-UI token would carry. If your API authorizes on scopes, the seeded session
   fails. Workarounds: authorize on the **ID token** / `cognito:groups` instead of scopes, or add scopes
   in a `V2_0` pre-token-generation Lambda (Essentials required — C8).
4. Amplify may also expect `signInDetails`; absence is tolerated in current versions but is another
   internals dependency.
5. If the app uses Amplify's `signInWithRedirect`, the OAuth-specific keys (`oauthSignIn`,
   `oauthPKCE`, `oauthState`, `oauthMetadata`) are set on the same prefix; you generally don't need them
   for a seeded session, but a "was this an OAuth sign-in" branch in your app might.

### Pattern B — your own httpOnly cookie session (recommended)

Your backend already has to turn the Cognito authorization code into a session for the bounce design
(D11). Give it a **preview-only** additional entry point:

```
POST /auth/test-login   { username, password }   →  Set-Cookie: session=…; HttpOnly; Secure; SameSite=Lax
```

whose handler calls `InitiateAuth` with `USER_PASSWORD_AUTH` server-side and issues your normal
session cookie. Playwright then just does `request.post('/auth/test-login', …)` and reuses the
`storageState`. Advantages: no dependence on library internals; the agent path is a single route that
you can `#if PREVIEW`-compile out of the prod bundle entirely (making it *structurally* absent, which
is your stated requirement); tokens never touch JavaScript-readable storage; and it survives Amplify
upgrades. AWS's own docs point at httpOnly/first-party session handling only obliquely (the app-client
page notes Cognito's managed-login cookies `cognito`, `cognito-fl`, `XSRF-TOKEN` and warns "We
recommend that … your application not set cookies on the subdomain that hosts your user pool domain
services"), so treat Pattern B as an application-architecture choice rather than a Cognito feature.

**Either way**, note the token-caching guidance AWS gives for cost: "Reuse access tokens until they
expire" (limits page, "Cache JWTs"). MAU billing counts sign-ins, so a Playwright suite that logs in
once per test run costs you 1 MAU/month, not N.

---

## E15. Token lifetimes

**Verdict:** Confirmed — access and ID tokens **5 minutes to 1 day**; refresh tokens **1 hour to
3,650 days (10 years)**. Defaults are 1 hour / 1 hour / 30 days.

From <https://docs.aws.amazon.com/cognito/latest/developerguide/limits.html>, "Amazon Cognito user
pools session validity parameters":

| Token | Quota |
| --- | --- |
| ID token | 5 minutes – 1 day |
| Refresh token | 1 hour – 3,650 days |
| Access token | 5 minutes – 1 day |
| Hosted UI session cookie | 1 hour |
| Authentication session token | 3 minutes – 15 minutes |

From <https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_CreateUserPoolClient.html>:

> `AccessTokenValidity` — "The default time unit for `AccessTokenValidity` in an API request is hours.
> *Valid range* is displayed below in seconds. **If you don't specify otherwise in the configuration of
> your app client, your access tokens are valid for one hour.**" Valid Range: Minimum value of 1.
> Maximum value of 86400.
> `IdTokenValidity` — same shape; "**your ID tokens are valid for one hour**" by default.
> `RefreshTokenValidity` — "The default time unit for `RefreshTokenValidity` in an API request is days.
> **You can't set `RefreshTokenValidity` to 0. If you do, Amazon Cognito overrides the value with the
> default value of 30 days.**" Valid Range: Minimum value of 0. Maximum value of **315360000** (= 3,650 days).
> `AuthSessionValidity` — Valid Range: Minimum value of 3. Maximum value of 15 (minutes).

**Minor doc discrepancy, flagged:** the API reference states the access/ID token valid range as
"Minimum value of 1 … Maximum value of 86400" seconds, whereas the quotas page says the minimum is
**5 minutes** (300 s). Trust the quotas page's 5-minute floor; a 1-second token will almost certainly
be rejected.

Also relevant if you set long refresh tokens: `RefreshTokenRotation` is now a per-client setting —
"When enabled, your app client issues new ID, access, and refresh tokens when users renew their
sessions with refresh tokens… Refresh token rotation must be completed with
`GetTokensFromRefreshToken`." (Refresh token rotation is an **Essentials+** feature per the pricing
Compare Tiers table.)

---

# F. Alternatives

## F16. Would plain "Sign in with Google" + your own session cookie be simpler?

**Verdict: For this specific project — several tiny personal sites, one solo developer, Google as the
*only* human IdP, plus a machine login for a test agent — yes, meaningfully simpler.** Cognito's real
value here would be the hosted login UI and the user directory, and you get neither benefit for free:
you still have to build a session layer for the bounce, you still have to hand-create a Google OAuth
client per site, and Cognito adds a 4-custom-domains-per-Region ceiling (A2), an
undocumented-but-real doc conflict about whether Lite supports social sign-in (A1), and a token-scope
gotcha on the machine path (E14). Against that, Cognito genuinely gives you: a persistent user
directory with groups you can put in tokens for free (C8), standards-compliant JWTs your API can
verify statelessly with an AWS-maintained library (C7), refresh tokens with configurable lifetimes up
to 10 years (E15), password-based machine login without you storing a password hash (E12), and a
real M2M client-credentials path if you ever need service-to-service auth (E13) — none of which you
get from Google Identity Services alone.

Google Identity Services is deliberately thin. From
<https://developers.google.com/identity/gsi/web/guides/overview>: it delivers "a personalized sign-in
button" and a "One Tap prompt"; "Users sign into a Google Account, provide their consent, and securely
share their profile information"; and the developer must "**Verify the Google ID token on your server
side**". It issues you an ID token and nothing else — no refresh tokens in the GIS web flow, no user
directory, no groups, no machine-credential story. Everything after "here is a verified email address"
is yours to build: a users table, a session cookie, and (for your agent) a test-login route — which is
exactly Pattern B from E14, which you were going to build anyway.

**The decision hinges on one question: do you want a user directory?** If your sites only ever need
"is this a signed-in Google account, and is its email on my allowlist", GIS + a signed httpOnly
session cookie is ~100 lines, has no per-site AWS resources, no domain quota, no exact-match callback
problem *at all* for PR previews (you register `preview.example.com` once in Google and bounce via
`state` exactly as in D11 — the bounce is required either way), and your Playwright agent just calls
your own test-login route. If instead you want per-user records, groups/roles in tokens, admin APIs,
or an eventual second IdP, Cognito earns its keep and one pool per site is a reasonable shape — just
budget for prefix domains rather than four custom domains.

**Middle path worth considering:** Cognito for prod (directory + Google + groups), and for PR previews
a **separate preview user pool** rather than extra app clients in the prod pool. It costs $0 (A1), and
it turns "the machine path must be structurally absent from prod" from an app-client-configuration
promise into an `iss`-claim guarantee that the prod verifier enforces automatically (C6).

---

# Summary of corrections to the premises in the question

1. **"Google OAuth redirect URIs are exact-match, so PR previews need a shared callback host."** —
   True that they're exact-match, but **Google never sees your PR hostnames.** Google's only redirect
   URI is `https://<pool-domain>/oauth2/idpresponse`, which is fixed forever. The exact-match problem
   for PR previews is **Cognito's** `CallbackURLs` list, which you *can* update from CI via
   `UpdateUserPoolClient`. The bounce is still the better design (no races, no 100-URL cap), but the
   constraint is not where you thought it was.
2. **"Free tier is 10,000 MAU"** — correct, and it's **per account, not per pool**, and it covers
   Lite *and* Essentials but **not** Plus. One-pool-per-site does not multiply it.
3. **"Max callback URLs ≈ 100"** — correct (100 callback, 100 logout, per app client, non-adjustable).
   The quota you didn't ask about and should worry about is **4 custom domains per Region, non-adjustable.**
4. **"M2M app clients are billed separately since Nov 2024"** — partly. **Token requests** are billed
   ($0.00225 each, no free tier); **app clients are explicitly not** ("There is no additional charge
   for the number of app clients you have registered in your account").
5. **"`SupportedIdentityProviders` needs `COGNITO` for `USER_PASSWORD_AUTH`"** — **No.** Removing
   `COGNITO` is cosmetic; it only changes the managed-login page. The flow is gated by
   `ExplicitAuthFlows`. Getting this wrong is exactly the kind of thing that would leave a password
   path open in prod while looking closed.
6. **"Essentials required for hosted UI with a custom domain"** — No: *classic hosted UI* works on
   Lite with a custom domain; only *managed login* (branding v2) requires non-Lite. But see the
   flagged doc conflict about social IdPs on Lite in A1 — test before committing to Lite.
7. **Testing-mode 7-day refresh expiry** — does **not** apply to the `openid`/`email`/`profile` scope
   set that Cognito's Google IdP uses.

# Things I could not verify

- **A single authoritative AWS sentence stating that one custom domain cannot serve two user pools.**
  Strong indirect evidence only (A3).
- **Any documented byte limit on Cognito's `state` parameter.** Only the format restriction
  (no URL-encoded JSON) is documented (D9).
- **A published Google limit on redirect URIs per OAuth client.** Google's own forum answer says there
  is no hard limit; the widely-cited "100" is not in Google's docs (B4).
- **Whether an app in Production status with only basic profile scopes skips Google verification
  review.** Widely believed, but I did not find a page stating it in those terms.
- **Whether Lite truly supports social IdP sign-in**, given the direct contradiction between the
  feature-plan table / pricing page and the social-IdP page (A1).
