---
paths:
  - "infra/**"
  - "packages/cdk-core/src/preview-site.ts"
  - "packages/cdk-core/src/preview-deployment.ts"
  - "packages/cdk-core/src/certificate.ts"
  - "packages/cdk-core/src/site.ts"
  - "packages/cdk-core/src/router/**"
  - "packages/cdk-core/src/handlers/**"
  - ".github/workflows/**"
---

# CDK, CloudFront, and the preview topology

Loaded when you touch `infra/`, a construct, the router, a handler, or a workflow.

Everything is **us-east-1** (CloudFront requires its ACM certificate there) in account
`063257577013`. The `admin` profile has **no default region**: `env` is explicit in
`bin/app.ts` and every CLI call needs `--region us-east-1`. Access is SSO —
`aws sso login --profile admin`, then `AWS_PROFILE=admin`.

> The account hosts three other production sites. **Never `destroy` or `delete-stack` a name
> you have not just read back from `aws cloudformation list-stacks`**, and never one that is
> not `CdkCore-pr-<n>` unless the epoch section says so.

## The stacks

| Stack | Deployed by | Holds |
| --- | --- | --- |
| `CdkCoreShared` | `deploy.yml` and by hand | the one ACM certificate |
| `CdkCorePreview` | `deploy.yml` (rarely changes) | `PreviewSite`: bucket, KVS, router function, distribution, wildcard DNS, SSM params |
| `CdkCore-pr-<n>` | `pr-preview.yml` per PR | the PR's Lambdas + `PreviewDeployment` |
| `CdkCoreSite` | `deploy.yml` on main | `Site` (Epoch 3) |
| `CdkCoreGithubOidc` | **by hand, once** | `GithubDeployRole` (Epoch 3) |

- **PR stacks read SSM, not CloudFormation exports.** An `Fn::ImportValue` would make every
  open PR a dependent of `CdkCorePreview` — blocking changes to it and breaking
  `cdk deploy CdkCore-pr-<n> --exclusively`. `PreviewSite` publishes
  `/cdk-core/<domain>/preview/{distributionArn,distributionId,bucketName,kvsArn}` and
  `PreviewDeployment` reads them. The **certificate** is the exception: it crosses from
  `CdkCoreShared` to `CdkCorePreview` as a normal construct reference, because those two
  stacks change together and neither is per-PR.
- **PR stacks are selected by context**: `cdk deploy CdkCore-pr-7 -c pr=7`. Without `-c pr=`,
  `cdk list` shows only the permanent stacks. `bin/app.ts` rejects a non-numeric `pr`, so the
  stack name cannot be forged from a context value — and the sweeper's `^CdkCore-pr-[0-9]+$`
  anchor depends on that.
- **`pnpm build` runs before any `synth`, `deploy` or `destroy`.** `PreviewDeployment` reads
  `apps/web/dist`, and `Code.fromAsset` reads `packages/cdk-core/dist/handlers/`, so a CDK
  command against a clean tree fails on a missing directory. Teardown synthesizes too.
- **`esbuild` is a *root* devDependency**, not `infra`'s: `NodejsFunction` runs the bundler
  from the workspace root where the lockfile is. Without it CDK silently falls back to Docker.

## CloudFront Functions (the router)

The router is **generated** by `renderRouterSource()` from the `backends` map — never edited
as a deployed artifact. It is associated as `viewer-request` on **every** behavior.

1. **`await` must never appear inside a call's argument list.** `JSON.parse(await kvs.get(k))`
   is a *syntax* error in the `cloudfront-js-2.0` engine:
   `SyntaxError: await in arguments not supported`. Because it is a syntax error the function
   never runs, and every request through the distribution returns
   **`503 The CloudFront function ... is invalid or could not run`** with no detail at the
   edge. Bind the awaited value to a variable first. `test/router.test.ts` asserts the
   generated source never does this.
2. **`aws cloudfront test-function` is the only thing that prints the real error.** Run it
   against the DEVELOPMENT stage before publishing anything. It also reports
   `ComputeUtilization` (0-100); the reference router sits at ~8.
3. **A KVS cannot be associated with a function until it reports `READY`.** `CreateFunction`
   against a `PROVISIONING` store fails with
   `InvalidArgument: ... cannot be associated before the resource is provisioned`
   (~35 s to provision). The CDK L2 orders this correctly; any CLI or custom-resource path
   must poll `describe-key-value-store` first.
4. **Sequential `await`s, no `Promise.all`** over KVS reads (memory), and one `kvs.get` per
   request.
5. **The function cannot change which cache behavior was selected.** Behavior selection
   happens on the *original* URI, before the function runs. So backend path patterns are fixed
   per distribution and the viewer's path must already distinguish `/api/*` from an asset.
   That is why the `backends` keys and their path prefixes are a contract shared by
   `PreviewSite`, `PreviewDeployment`, `apps/web` and Vite's dev proxy — adding a third prefix
   means adding it in all of them.

## Origins, OAC, and the 403s that leave no trace

6. **Both `lambda:InvokeFunctionUrl` *and* `lambda:InvokeFunction` must be granted** to
   `cloudfront.amazonaws.com` with the distribution's `SourceArn`. Measured in the Epoch 2
   spike, each direction, with the baseline re-confirmed after: `InvokeFunctionUrl` alone
   → **403**, `InvokeFunction` alone → **403**, both → 200. CDK's
   `withOriginAccessControl` still grants only the former (aws/aws-cdk#35872), and
   `PreviewDeployment` adds both `CfnPermission`s itself. Symptom when it is wrong: every
   request 403s and **nothing appears in the Lambda's logs** — it is never invoked.
7. **The origin request policy must exclude `host` and only `host`**
   (`ALL_VIEWER_EXCEPT_HOST_HEADER`). The deny list applies to the *outbound* headers, which
   by then include the `Authorization` header OAC just added — denying `authorization` strips
   CloudFront's own signature. This is also why the ID token travels in `x-id-token`.
8. **A POST with a body through OAC needs `x-amz-content-sha256` from the viewer.** SigV4
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
9. **Backend behaviors are assigned `origin-placeholder.invalid`**, which the router overrides
   on every request. CloudFront does no resolvability check at `CreateDistribution`, so this
   is legal, and it is chosen so that a router which fails to override the origin fails
   loudly instead of quietly reaching a real host.
10. **SPA fallback serves the shell, it does not append `index.html`.** An extensionless
    path is a client route, so the router rewrites it to `<assets>/index.html` — rewriting it
    to `<path>/index.html` makes every deep route 403. Not 404: an OAC bucket policy grants
    `s3:GetObject` and not `s3:ListBucket`, so S3 answers a missing key `AccessDenied`. A
    request for a genuinely missing *asset* still fails, which is the point of keying on the
    extension. `test/router.test.ts` executes the generated source against real event objects
    precisely because this bug passed every substring assertion.
11. **The rewritten `request.uri` is part of the cache key; `originPath` is not.** Proven in
    the spike with query strings excluded from the cache policy: two `pr-<n>/` prefixes served
    the same viewer path with different bodies, both from cache. That is what makes one shared
    preview bucket safe. Do not switch to `originPath`.

## Streaming

`hono/aws-lambda`'s `streamHandle` → a function URL with `invokeMode: RESPONSE_STREAM` → a
`CACHING_DISABLED`, `compress: false` behavior, with the router setting
`timeouts.readTimeout` per backend.

- **`RESPONSE_STREAM` is fixed when the function URL is created.** A buffered URL cannot be
  promoted, only replaced. That is the whole reason `/events` is a second Lambda rather than a
  route on the first.
- **`readTimeout` is the real deadline, not the Lambda timeout.** CloudFront waits that long
  for the first byte *and* between packets; 60 s is the ceiling without a quota increase, and
  `renderRouterSource` defaults streaming backends to exactly 60. A producer that goes quiet
  longer is cut off at the edge while the Lambda keeps running (and billing) — hence the
  `: keepalive` every 10 s in `apps/api/src/events.ts`.
- **CloudFront does not compress `text/event-stream` and does not buffer chunked responses.**
  `compress: false` is set because it says what is meant, not because it measured faster.

## KeyValueStore writes

- **The ETag versions the whole store**, so two PR stacks deploying at once conflict even on
  different keys. Every write is describe→`UpdateKeys` retried *as a unit*, re-describing each
  attempt.
- **A stale ETag returns `ValidationException: Pre-Condition failed during update of
  Key-Value-Store`** — measured, not `ConflictException`. The handler retries on both anyway,
  because the mapping is undocumented and could change.
- **Deleting a key that does not exist succeeds** (measured: same ETag back, `ItemCount`
  unchanged). So does a delete against a store that is gone, which the handler turns into
  success explicitly — a stack delete must never wedge on cleanup.
- **The bundled handler must import `@aws-sdk/signature-v4a` for its side effect.** The KVS
  data-plane endpoint is global, so the client signs with SigV4A, and the AWS SDK ships no
  SigV4A implementation — it looks one up in a registry that a separate package populates on
  import. Bundled, that lookup finds nothing and *every* call fails at `describe` with
  `Neither CRT nor JS SigV4a implementation is available`, taking the whole PR stack down.
  `src/handlers/preview-resources.ts` carries the import with a comment saying it is not
  unused; the package declares `sideEffects: true`, so esbuild keeps it.
- Calling the KVS API needs SigV4A for the other reason too: a CI runner using the *global*
  STS endpoint gets a v1 token that fails. That is why the writer is a Lambda-backed custom
  resource and not a step in a workflow.

## Deleting things

CloudFront requires a distribution to be **disabled and fully deployed** before it can be
deleted, and a function cannot be deleted while a distribution still references it. So the
order is: disable → `wait distribution-deployed` → delete distribution → delete function →
delete KVS. `cdk destroy` handles this; a hand-built resource does not.
