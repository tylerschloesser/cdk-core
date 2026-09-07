---
name: preview
description: Use when opening a PR that needs a preview environment, waiting for one to deploy, testing against one, or reading why one failed.
---

# PR previews

## Topology

One CloudFront distribution is shared by every open PR on a site. A single KeyValueStore
(KVS) maps each preview hostname to that PR's Lambda function URLs. A viewer-request
CloudFront Function (the "router"), associated on every behavior, reads the KVS entry for the
request's host and either rewrites `request.uri` to `/pr-<n>/…` (assets, served from one
shared S3 bucket under a per-PR prefix) or overrides the origin to the PR's Lambda URL
(backends). The PR stack itself (`<Prefix>-pr-<n>`, e.g. `CdkCore-pr-12`) holds only that PR's
backend Lambdas plus a `PreviewDeployment` construct — no distribution, no bucket, no KVS of
its own.

Hostnames: `https://pr-<n>.preview.<domain>` for a preview, `https://<domain>` for production.
For this repo, `<domain>` is `cdk-core.ty.ler.dev` and `<Prefix>` is `CdkCore`.

## Timings

Measured, not promised (see `plan.md`'s Status block): a brand-new preview stack takes ~95 s
at the `cdk deploy` step, a repeat deploy to an existing PR stack ~29-33 s, and a real
`git push` to the sticky comment landing on the PR takes 88-113 s end to end. Waiting around 2
minutes for a preview is normal. If you are still waiting at 5 minutes, something is wrong —
go read logs, don't keep polling.

## Opening the PR is part of the task

"Verify it in a preview" means: make the change, open the PR, wait for the preview, check it.
Do not stop after committing to ask whether to push — the push *is* the verification, and
there is nothing to verify without it.

That is a judgement about this specific action, not a general licence. Deploying a PR preview
is routine, self-cleaning and cheap: `pr-teardown.yml` deletes the stack when the PR closes,
the daily sweeper catches whatever teardown missed, and the deploy role's IAM cannot touch
anything outside `<Prefix>-pr-*`. The idle cost of a live preview is pennies.

What does deserve a question first, every time: deleting or destroying any stack (see the last
section), deploying to production, publishing a package, force-pushing, closing someone else's
PR, or anything touching the prod user pool.

## Opening a PR and waiting for its preview

```
gh pr create --fill
gh run list --workflow pr-preview.yml --branch <branch> --limit 1
gh run watch <run-id> --exit-status
```

`gh run watch --exit-status` blocks until the run finishes and exits non-zero if it failed —
that is the wait. Once it succeeds:

```
scripts/verify-preview.sh <n>
```

This is pure `curl` (plus `python3` for JSON/timing checks) — no AWS credentials needed. It
checks: assets serve at `GET /`, the SPA fallback serves the same `index.html` for a deep
client route, `/__config.json` reports `mode: preview` and the right `pr`, `/api/ping`
answers, a signed `POST /api/echo` round-trips, `/events/tick?n=5` refuses an unauthenticated
request with **401**, and an unrelated PR number 404s.

To actually stream the events rather than just prove they are protected, pass a token — this
is the one part that needs AWS credentials, and it lives outside the script for that reason:

```
scripts/verify-preview.sh <n> --id-token "$(scripts/preview-login.sh <n>)"
```

That form checks five `event: tick` frames arrive with real inter-arrival spread (about
2000 ms across five, 500 ms between the first two) rather than buffered into one write. See
the `preview-auth` skill for where the token comes from.

Then run the e2e suite against the preview:

```
PLAYWRIGHT_BASE_URL=https://pr-<n>.preview.<domain> pnpm e2e
```

The unauthenticated specs pass with no credentials. The authenticated specs
(`e2e/auth.spec.ts`'s machine-auth tests) need AWS credentials to mint a Cognito token for the
preview's machine user — see the `preview-auth` skill for that path.

## What the sticky comment looks like

`pr-preview.yml` edits one comment in place (`gh pr comment --edit-last --create-if-none`) on
every push, so a PR always has exactly one preview comment, not one per push:

```
### PR Preview

✅ deployed and e2e passed

- URL: https://pr-12.preview.cdk-core.ty.ler.dev
- Commit: <sha>
- deploy 93 s · push → comment 101 s
```

The status line is one of three: `✅ deployed and e2e passed`, `⚠️ deployed, but e2e
<outcome>` (the preview exists but something in the suite failed), or `❌ deploy <outcome> —
the preview may not exist` (the deploy step itself failed). The comment step runs with
`if: always()`, so a broken preview still tells you where to look.

## Reading logs when it fails

```
gh run view <run-id> --log-failed
```

For the CloudFormation side: `aws cloudformation describe-stack-events --region us-east-1
--stack-name <Prefix>-pr-<n>` shows why a resource failed to create or update. For Lambda
logs, first find the physical function name (`aws cloudformation describe-stack-resources
--region us-east-1 --stack-name <Prefix>-pr-<n>`), then `aws logs tail
/aws/lambda/<physical-name> --since 1h`.

Two failure modes are silent at every one of those layers:

- **A 503 at the edge on every request** through the preview distribution means the router
  CloudFront Function has a syntax error — almost always `await` used inside a call's argument
  list, which `cloudfront-js-2.0` rejects at publish time with no detail reaching the response.
  Diagnose with `aws cloudfront test-function --name <function-name> --if-match <etag>
  --stage DEVELOPMENT --event-object file://event.json` (the ETag comes from `aws cloudfront
  describe-function --name <function-name> --stage DEVELOPMENT`) — it prints the real error;
  the edge 503 does not.
- **A 403 on every backend request with nothing in the Lambda's log group** means the OAC
  invoke permissions are wrong — the function was never invoked. Both
  `lambda:InvokeFunctionUrl` and `lambda:InvokeFunction` must be granted to
  `cloudfront.amazonaws.com`; either alone is a 403.

KVS propagation to the edge has no published SLA (AWS says only "a few seconds"), which is why
`pr-preview.yml` polls `/api/ping` in a loop after the CloudFormation deploy completes rather
than assuming the router already knows the new hostname.

## Teardown and the sweeper

`pr-teardown.yml` deletes the PR's stack when the PR closes (merged or not) — no wait, no
checkout, no CDK, just `aws cloudformation delete-stack`. A daily `cleanup.yml` runs
`cdk-core sweep` to catch anything teardown missed: a stack whose PR closed while the workflow
was down, an orphaned KVS key, an orphaned `pr-<n>/` prefix in the shared bucket.

To confirm a torn-down preview is actually gone from the outside:

```
scripts/verify-preview.sh <n> --expect-absent
```

This flips the same checks to expect 404 instead of 200. **Do not trust a failure here until
the stack delete has finished and another minute has passed.** `pr-teardown.yml` calls
`delete-stack` and does not wait, on purpose, so the workflow going green means the delete
*started*.

What you see while you wait is **403**, not a stale 200, and on `/api/*` too — which is
`CACHING_DISABLED`, so edge caching cannot explain it. The cause is KVS propagation: the key is
already gone from the store (`list-keys` returns `[]` immediately) but some edges still resolve
it, rewrite the request to `/pr-<n>/index.html` in a bucket where the object is gone, and get
S3's `AccessDenied` — a 403 rather than a 404 because an OAC bucket policy grants `GetObject`
and not `ListBucket`. Measured in Epoch 5: 1 of 7 checks passing while the stack was still
deleting, 3 of 7 the moment it finished, 7 of 7 under a minute later.

So the sequence that gives a trustworthy answer is: wait for `describe-stacks` to stop finding
`<Prefix>-pr-<n>`, wait another minute, then run the check.

## What never to do

Never run `aws cloudformation delete-stack` or `cdk destroy` against a stack name you have not
just read back from `aws cloudformation list-stacks` — this AWS account hosts other production
sites that share nothing with this one but the account id. And never delete anything that is
not `<Prefix>-pr-<n>` unless you have a specific reason recorded elsewhere.

Never hand-edit the deployed CloudFront Function. Its source is generated by
`renderRouterSource()` from the site's backend definitions; editing the deployed function
directly means the next `cdk deploy` silently reverts your change, or worse, diverges from
what `test/router.test.ts` actually asserts.
