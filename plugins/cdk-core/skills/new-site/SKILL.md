---
name: new-site
description: Use when setting up a new site or repo on @tylerschloesser/cdk-core, adding the preview + auth infrastructure to an existing repo, or checking that an onboarding is complete.
---

# Onboarding a site onto cdk-core

Site-specific values are written as `<domain>`, `<Prefix>`, `<n>`. This assumes a brand-new
consumer repo; see the `preview` and `preview-auth` skills for day-to-day behavior once it's up.

## 1. What you get, and what it costs

Four stacks, always deployed in this shape:

| Stack | Deployed by | Holds |
| --- | --- | --- |
| `<Prefix>Shared` | your deploy workflow, and by hand | the one ACM certificate |
| `<Prefix>Preview` | your deploy workflow (rarely changes) | preview bucket, KVS, router function, preview distribution, wildcard DNS, preview user pool + machine user, SSM params |
| `<Prefix>Site` | your deploy workflow, on push to `main` | prod bucket, distribution, DNS apex, prod user pool, your backend Lambdas |
| `<Prefix>-pr-<n>` | your PR workflow, one per open PR | that PR's backend Lambdas + its slice of the preview |

Plus `<Prefix>GithubOidc`, deployed **by hand, once** — see the human actions below.

Prod answers at `https://<domain>`. Previews answer at `https://pr-<n>.preview.<domain>`. The
OAuth bounce host is `https://oauth.preview.<domain>`. All of it sits behind one ACM
certificate in `us-east-1` with SANs `[<domain>, *.preview.<domain>]`.

Idle cost is pennies: two CloudFront distributions, two S3 buckets, one KeyValueStore, one
CloudFront Function, two Cognito pools (10,000 MAU free tier is per account, not per pool),
and up to three Secrets Manager secrets at $0.40/month each. Real money is spent only by a
leaked PR stack taking traffic, or a runaway stream — see `plan.md`'s Cost guardrails.

## 2. The CDK app

Copy the templates into your repo:

```
cp templates/app.ts infra/bin/app.ts
cp templates/cdk.json infra/cdk.json
cp templates/infra-package.json infra/package.json
```

`infra/package.json` names the `infra` workspace package; `app.ts` is the whole CDK app — one
call to `defineSiteStacks()`. Every `{{PLACEHOLDER}}` in it needs a real value before it will
synth:

| Placeholder | Where the value comes from |
| --- | --- |
| `{{PACKAGE_NAME}}` | always `@tylerschloesser/cdk-core` — not a per-site choice |
| `{{ACCOUNT_ID}}` | `aws sts get-caller-identity --query Account --output text` |
| `{{REGION}}` | `us-east-1` — CloudFront's certificate requirement, not a choice |
| `{{STACK_PREFIX}}` | your choice, e.g. `CdkCore` — becomes the four stack names |
| `{{SITE_DOMAIN}}` | your choice, e.g. `cdk-core.ty.ler.dev` |
| `{{ZONE_ID}}` / `{{ZONE_NAME}}` | `aws route53 list-hosted-zones --query "HostedZones[].{Id:Id,Name:Name}"` — pick the zone containing `{{SITE_DOMAIN}}` |
| `{{AUTH_PREFIX}}` | your choice, e.g. `cdk-core` — must match what you type into Google, below |
| `{{PREVIEW_AUTH_PREFIX}}` | your choice, e.g. `cdk-core-preview` — same warning |
| `{{REPO}}` | `owner/name`, e.g. `tylerschloesser/cdk-core` |
| `{{ROLE_NAME}}` | your choice, e.g. `cdk-core-github-deploy` |
| `{{REPO_OWNER_ID}}` / `{{REPO_ID}}` | `gh api repos/<owner>/<name> --jq '.owner.id, .id'` |

`{{AUTH_PREFIX}}` and `{{PREVIEW_AUTH_PREFIX}}` are written out as literals rather than
derived from `{{SITE_DOMAIN}}`, because they also have to exist in a place CDK cannot reach:
the Google OAuth client's authorized redirect URIs (step 4 below). A mismatch there is a
`redirect_uri_mismatch` at Google with nothing in any AWS log.

`pnpm build` must run before any `cdk` command — `Site` and `PreviewDeployment` read
`apps/web/dist` from disk, and `PreviewSite`/`PreviewDeployment` read the package's bundled
Lambda handlers out of `node_modules/@tylerschloesser/cdk-core/dist/handlers/`. A `cdk synth`
against a clean tree with neither built fails on a missing directory, not a helpful message.

## 3. The workflows

Copy the four templates in `templates/workflows/` to `.github/workflows/`. Each carries
`{{SITE_DOMAIN}}` and `{{STACK_PREFIX}}`; `pr-teardown.yml` needs no build, so no `{{PACKAGE_NAME}}`.

| Workflow | Trigger | What it does |
| --- | --- | --- |
| `deploy.yml` | push to `main`, dispatch | verify, e2e locally, deploy `<Prefix>Shared <Prefix>Preview <Prefix>Site`, poll `/api/ping`, e2e against production |
| `pr-preview.yml` | PR opened/synchronize/reopened | build, `cdk deploy <Prefix>-pr-$PR --exclusively -c pr=$PR`, poll the preview, e2e, sticky comment with URL and timings |
| `pr-teardown.yml` | PR closed | `aws cloudformation delete-stack` on `<Prefix>-pr-$PR`, no wait, no checkout |
| `cleanup.yml` | daily cron + dispatch | `pnpm --filter infra exec cdk-core sweep --site {{SITE_DOMAIN}} --stack-prefix {{STACK_PREFIX}} --repo <owner>/<name>` |

Two details from `.claude/rules/workflows.md` cost a debugging cycle the first time and are
worth knowing up front:

- **Everything that touches CloudFormation is `cancel-in-progress: false`.** Cancelling a job
  does not cancel the CloudFormation operation it started, and the next run would hit a stack
  stuck `UPDATE_IN_PROGRESS`. `pr-teardown.yml` shares `pr-preview.yml`'s concurrency group so
  a close can never race a deploy for the same PR.
- **`pr-teardown.yml` needs `GH_REPO`.** It deliberately has no checkout — a PR whose branch no
  longer builds still has to tear down — so `gh pr comment` has no git remote to infer the
  repository from and exits 1 without it, after the delete already succeeded.

## 4. Human actions

Claude cannot do these. In order:

1. **Deploy `<Prefix>GithubOidc` by hand, once**: `pnpm --filter infra exec cdk deploy
   <Prefix>GithubOidc`. It imports the account's OIDC provider and creates the role your
   workflows assume — a workflow cannot grant itself this trust, so it must exist first.
2. **Set the deploy role as a repo variable**: `gh variable set AWS_DEPLOY_ROLE_ARN --body
   <role-arn>`. Unblocks every workflow above.
3. **Create or reuse a Google OAuth client** (Google Cloud console, one Web client covers every
   site) and add **two** authorized redirect URIs:
   `https://{{AUTH_PREFIX}}.auth.us-east-1.amazoncognito.com/oauth2/idpresponse` and
   `https://{{PREVIEW_AUTH_PREFIX}}.auth.us-east-1.amazoncognito.com/oauth2/idpresponse`.
   Unblocks Google login on prod and on previews.
4. **Put the client's credentials in Secrets Manager**: `aws secretsmanager create-secret
   --name cdk-core/google-oauth --secret-string '{"clientId":"...","clientSecret":"..."}'
   --region us-east-1` (or whatever `AuthProps.googleSecretName` names) — `Site.auth`/
   `PreviewSite.auth` read it at deploy time.
5. **Make sure the hosted zone exists** for `{{SITE_DOMAIN}}`, for the certificate and both
   distributions' DNS records.

**The failure mode with no log**: if a Cognito domain prefix does not match exactly what was
typed into Google, the result is `redirect_uri_mismatch` **at Google** — nothing appears in
any CloudTrail event, CloudFormation event, or CloudWatch log, because the request never
reaches AWS. Check the pair before touching a browser:

```
curl -sS -L --max-time 15 -o /tmp/authcheck.html \
  "https://{{AUTH_PREFIX}}.auth.us-east-1.amazoncognito.com/oauth2/authorize?client_id=<browser-client-id>&response_type=code&scope=openid+email+profile&redirect_uri=https%3A%2F%2F{{SITE_DOMAIN}}%2Fauth%2Fcallback&identity_provider=Google"
grep -o "Error 400\|redirect_uri_mismatch\|Sign in" /tmp/authcheck.html
```

A working pair ends on a Google sign-in page (`Sign in` present, no `Error 400`). A mismatch
ends on an error page instead — fix the prefix or the redirect URI and try again, no login
required either way.

## 5. The plugin wiring

Add this to the consumer repo's `.claude/settings.json` so its Claude loads these skills:

```json
{
  "extraKnownMarketplaces": {
    "tylerschloesser": {
      "source": { "source": "github", "repo": "tylerschloesser/cdk-core" }
    }
  },
  "enabledPlugins": {
    "cdk-core@tylerschloesser": true
  }
}
```

This repo's own `.claude/settings.json` carries the same two keys but with `"source": {
"source": "directory", "path": "." }` — it dogfoods the plugin from its own checkout instead
of fetching itself over the network. A separate consumer repo needs the GitHub form above.

**The skills appear one session late.** The first session started after the setting lands
registers the marketplace but does not yet expose the plugin's skills; the *next* session does.
Measured in Epoch 5, in both the absolute-path and relative-`"."` directory forms. So a first
run that cannot see `preview` or `new-site` is not a broken manifest — start a second session
before debugging anything. `claude plugin marketplace list` tells you which half you are in: it
does not list your marketplace until that first session has run, and does afterwards
(`~/.claude/plugins/known_marketplaces.json` holds the same record, with the path resolved).

## 6. Verification checklist

Run in order; each line says what a good answer looks like.

1. `pnpm --filter infra exec cdk synth <Prefix>Shared <Prefix>Preview <Prefix>Site
   <Prefix>GithubOidc` — synthesizes with no error, no placeholder left unfilled.
2. `pnpm --filter infra exec cdk deploy <Prefix>Shared <Prefix>Preview <Prefix>Site
   --require-approval never` — by hand, once, as this repo did for `CdkCoreSite` (a first
   CloudFront create is a multi-minute round trip; keep it off a workflow's first try).
3. `curl -fsS https://<domain>/api/ping` — `pong`.
4. Open a throwaway PR and watch `pr-preview.yml` (the `preview` skill covers the full loop),
   then `scripts/verify-preview.sh <n>` — all checks pass against the new preview.
5. Close the PR and watch `pr-teardown.yml`; `scripts/verify-preview.sh <n> --expect-absent`
   after about a minute — everything now 404s.
6. `AWS_PROFILE=admin pnpm --filter infra exec cdk-core sweep --site <domain> --stack-prefix
   <Prefix> --repo <owner>/<name> --dry-run` — exits 0, prints `(nothing to reconcile)`.

For the machine-auth path (curling a protected endpoint or seeding a Playwright session with
no browser), see the `preview-auth` skill — it is the same on every site once `auth` is
configured.

## 7. What not to do

- Never run `aws cloudformation delete-stack` or `cdk destroy` against a stack name you have
  not just read back from `aws cloudformation list-stacks`. The account this was built for
  hosts other production sites that share nothing with a new site but the account id.
- Never create a second GitHub OIDC provider. There is one per AWS account; import it
  (`GithubDeployRole`'s default) rather than creating a second one.
- Never add a native user or a non-refresh auth flow to the **prod** pool. Prod having no
  password path is a deliberate, asserted property (`CLAUDE.md`, `.claude/rules/auth.md`) — it
  is what makes machine sign-in structurally impossible outside previews.
