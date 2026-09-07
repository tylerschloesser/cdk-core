---
paths:
  - "infra/**"
  - "packages/cdk-core/src/preview-site.ts"
  - "packages/cdk-core/src/preview-deployment.ts"
  - "packages/cdk-core/src/certificate.ts"
  - "packages/cdk-core/src/site.ts"
  - "packages/cdk-core/src/behaviors.ts"
  - "packages/cdk-core/src/router/**"
---

# CDK, CloudFront, and the preview topology

Loaded when you touch `infra/`, a construct or the router. Three neighbours: `workflows.md`
(workflows, the deploy role, the sweeper), `streaming-and-kvs.md` (the streaming contract and
KVS writes) and `auth.md` (the user pools, Google, the machine user).

Everything is **us-east-1** (CloudFront requires its ACM certificate there) in account
`063257577013`. The `admin` profile has **no default region**: `env` is explicit in
`bin/app.ts` and every CLI call needs `--region us-east-1`. Access is SSO — `aws sso login
--profile admin`, then `AWS_PROFILE=admin`.

> The account hosts three other production sites. **Never `destroy` or `delete-stack` a name
> you have not just read back from `aws cloudformation list-stacks`**, and never one that is
> not `CdkCore-pr-<n>` unless the epoch section says so.

## The stacks

| Stack | Deployed by | Holds |
| --- | --- | --- |
| `CdkCoreShared` | `deploy.yml` and by hand | the one ACM certificate |
| `CdkCorePreview` | `deploy.yml` (rarely changes) | `PreviewSite`: bucket, KVS, router, distribution, wildcard DNS, SSM params, **preview pool + machine user** |
| `CdkCore-pr-<n>` | `pr-preview.yml` per PR | the PR's Lambdas + `PreviewDeployment` |
| `CdkCoreSite` | `deploy.yml` on main | `Site`: prod bucket, distribution, SPA function, apex DNS, **the prod user pool** |
| `CdkCoreGithubOidc` | **by hand, once** | `GithubDeployRole`; its `roleArn` is the `AWS_DEPLOY_ROLE_ARN` repo variable |

- **`defineSiteStacks()` builds all five**, and is the only thing in the package that creates a
  `Stack`. It is a function, not a construct: it composes `siteCertificate`, `Site`,
  `PreviewSite`, `PreviewDeployment` and `GithubDeployRole` exactly as `bin/app.ts` used to, and
  returns every stack and construct it made. Adding a stack shape it cannot express means going
  back to the constructs, not widening its props until it can.
- **PR stacks read SSM, not CloudFormation exports.** An `Fn::ImportValue` would make every
  open PR a dependent of `CdkCorePreview` — blocking changes to it and breaking
  `cdk deploy CdkCore-pr-<n> --exclusively`. `PreviewSite` publishes
  `/cdk-core/<domain>/preview/{distributionArn,distributionId,bucketName,kvsArn}` plus four
  auth keys (`auth.md`), and `PreviewDeployment` reads them — taking an explicit
  `auth: boolean`, because a missing parameter fails the *deploy*, not the synth. The
  **certificate** is the exception: it crosses from
  `CdkCoreShared` to `CdkCorePreview` as a normal construct reference, because those two
  stacks change together and neither is per-PR.
- **PR stacks are selected by context**: `cdk deploy CdkCore-pr-7 -c pr=7`. Without `-c pr=`,
  `cdk list` shows only the permanent stacks. `defineSiteStacks()` rejects a non-numeric `pr`, so
  the stack name cannot be forged from a context value — and the sweeper's `^CdkCore-pr-[0-9]+$`
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
   `ComputeUtilization` (0-100), where the reference router sits at ~8 — but that is one
   synthetic invocation, and **at the real edge the p99 is 26.4-30.0% (max 30)**, measured
   under ~800 requests. Treat `test-function`'s figure as a smoke test, not a budget.
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
6. **Reading the metric needs `Region=Global` as well as `FunctionName`.** With `FunctionName`
   alone, `cloudwatch get-metric-statistics` returns an empty datapoint list and *no error*,
   which reads exactly like a function that was never invoked.
7. **The router costs no latency worth designing around.** 40 interleaved pairs, order
   randomized within each pair, put the preview at a median 206.9 ms against production's
   210.4 ms — a per-pair delta of **-5.2 ms**. The KVS read and `updateRequestOrigin()` are
   under the noise floor.

**A deleted PR stack leaves its CloudWatch log groups behind — the sweeper reclaims them, the
constructs do not.** Lambda creates `/aws/lambda/<function-name>` on first invoke, so
CloudFormation never owns the group and never deletes it with the stack. 65 had accumulated
(~68 KB, no retention) before issue #12 was fixed sweeper-side: `cdk-core sweep` has a fourth
step matching `^/aws/lambda/<prefix>-pr-([0-9]+)-`, described in `.claude/rules/workflows.md`
(this rule's `paths` do not cover `sweep/**`). So **do not** "fix" this by adding an explicit
`logGroup` with `RemovalPolicy.DESTROY` to a function here without reading issue #12 first: it
cannot deploy over an existing group, it does not reach the functions a *consumer* declares,
and it puts a new way to fail on the critical path of every preview deploy. It remains a
possible later addition, not a replacement for the sweeper step.

The origin side — OAC, the invoke permissions, the POST payload hash, and the order a
distribution has to be deleted in — is `.claude/rules/cloudfront-origins.md`.
