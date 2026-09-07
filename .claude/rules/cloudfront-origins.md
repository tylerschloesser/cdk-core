---
paths:
  - "packages/cdk-core/src/behaviors.ts"
  - "packages/cdk-core/src/preview-site.ts"
  - "packages/cdk-core/src/preview-deployment.ts"
  - "packages/cdk-core/src/site.ts"
  - "packages/cdk-core/src/router/**"
  - "packages/cdk-core/src/auth/browser.ts"
---

# CloudFront origins, OAC, and deleting distributions

Split out of `.claude/rules/cdk.md` in Epoch 5, which had grown past the ~120 lines `CLAUDE.md`
asks for. That file still holds the stacks and the router function; this one holds the origin
side — every item below is a failure that leaves **no trace** in any log, which is why they are
written down at all. The user pools are `auth.md`, KVS writes are `streaming-and-kvs.md`.

## Origins, OAC, and the 403s that leave no trace

1. **Both `lambda:InvokeFunctionUrl` *and* `lambda:InvokeFunction` must be granted** to
   `cloudfront.amazonaws.com` with the distribution's `SourceArn`. Measured in the Epoch 2
   spike, each direction, with the baseline re-confirmed after: `InvokeFunctionUrl` alone
   → **403**, `InvokeFunction` alone → **403**, both → 200. CDK's
   `withOriginAccessControl` still grants only the former (aws/aws-cdk#35872), and
   `PreviewDeployment` adds both `CfnPermission`s itself. Symptom when it is wrong: every
   request 403s and **nothing appears in the Lambda's logs** — it is never invoked.
2. **The origin request policy must exclude `host` and only `host`**
   (`ALL_VIEWER_EXCEPT_HOST_HEADER`). The deny list applies to the *outbound* headers, which
   by then include the `Authorization` header OAC just added — denying `authorization` strips
   CloudFront's own signature. This is also why the ID token travels in `x-id-token`.
3. **A POST with a body through OAC needs `x-amz-content-sha256` from the viewer.** SigV4
   covers a payload hash CloudFront cannot compute, so the caller supplies it. Measured
   through the preview distribution:

   | Request | Result |
   | --- | --- |
   | `GET` | 200 |
   | `POST` with a body, no `x-amz-content-sha256` | **403** |
   | `POST` with a body, wrong hash | **403** |
   | `POST` with a body and the correct hash | 200 |

   `apiFetch` in `auth/browser` computes it; `/api/echo` and `e2e/api.spec.ts` exist to keep
   that path exercised. It also rules out `EventSource`, which only issues GETs.
4. **Backend behaviors are assigned `origin-placeholder.invalid`**, which the router overrides
   on every request. CloudFront does no resolvability check at `CreateDistribution`, so this
   is legal, and it is chosen so that a router which fails to override the origin fails
   loudly instead of quietly reaching a real host.
5. **SPA fallback serves the shell, it does not append `index.html`.** An extensionless
   path is a client route, so the router rewrites it to `<assets>/index.html` — rewriting it
   to `<path>/index.html` makes every deep route 403. Not 404: an OAC bucket policy grants
   `s3:GetObject` and not `s3:ListBucket`, so S3 answers a missing key `AccessDenied`. A
   request for a genuinely missing *asset* still fails, which is the point of keying on the
   extension. `test/router.test.ts` executes the generated source against real event objects
   precisely because this bug passed every substring assertion.
6. **The rewritten `request.uri` is part of the cache key; `originPath` is not.** Proven in
   the spike with query strings excluded from the cache policy: two `pr-<n>/` prefixes served
   the same viewer path with different bodies, both from cache. That is what makes one shared
   preview bucket safe. Do not switch to `originPath`.

## Deleting things

CloudFront requires a distribution to be **disabled and fully deployed** before it can be
deleted, and a function cannot be deleted while a distribution still references it. So the
order is: disable → `wait distribution-deployed` → delete distribution → delete function →
delete KVS. `cdk destroy` handles this; a hand-built resource does not.
