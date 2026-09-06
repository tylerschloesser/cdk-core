# Spike: dynamic Lambda-URL origins under OAC, and URI-rewrite cache keys

**Date** 2026-09-06 · **Epoch** 2 · **Region** us-east-1 · **Account** 063257577013

Two claims the whole preview design rests on, neither of them documented, both settled here by
hand before a line of construct code was written. `plan.md` Risks #1 and #4.

| Question | Verdict |
| --- | --- |
| **D1** — does an inline `originAccessControlConfig` on `cf.updateRequestOrigin()` actually SigV4-sign a request to a `RESPONSE_STREAM` Lambda function URL that is **not** an origin in the distribution? | **Yes.** Streams incrementally, and a POST body works iff the caller sends `x-amz-content-sha256`. No fallback needed; D1's `AuthType: NONE` + secret-header plan B is unused. |
| **D10** — is the *rewritten* `request.uri` part of the cache key, so two PR prefixes serving the same path do not collide? | **Yes.** Two prefixes, identical viewer path, different bodies, both served from cache, no cross-contamination. |

Three findings that were not in the plan are at the bottom. The `await`-in-arguments one is a
hard syntax error that will bite anyone writing a CloudFront Function.

## What was built

Everything named `cdk-core-spike-*`, all torn down at the end of the session (see Teardown).

| Resource | Identifier |
| --- | --- |
| Lambda (Node 22, arm64) | `cdk-core-spike-stream` — SSE on GET, echo on POST |
| Function URL | `AuthType: AWS_IAM`, `InvokeMode: RESPONSE_STREAM` |
| S3 bucket | `cdk-core-spike-assets-063257577013`, objects `pr-1/index.html`, `pr-2/index.html` with **different bodies** |
| KeyValueStore | `cdk-core-spike`, keys `pr-1` / `pr-2` → `{"assets":"/pr-N","backend":"<fn-url host>"}` |
| CloudFront Function | `cdk-core-spike-router`, runtime `cloudfront-js-2.0`, KVS associated |
| OAC (S3) | `E24UT7LJQSHBID` |
| Distribution | `EDMRJTHS7Q1HF` / `d2m7c98qe0u10h.cloudfront.net` |

The distribution deliberately mirrors the real preview topology, with one substitution: there
are no custom hostnames on the spike (no cert), so the router keys off a `?p=<n>` query
parameter where the real one keys off the `Host` header. That substitution is what makes the
D10 test *stronger* than the real case rather than weaker — see below.

- **Default behavior** → the S3 origin, `CachePolicy` `CACHING_OPTIMIZED`
  (`658327ea-f89d-4fab-a63d-7e88639e58f6`), which puts **no query strings in the cache key**.
- **`/stream*` and `/echo*`** → a *placeholder* custom origin, `CACHING_DISABLED`
  (`4135ea2d-6df8-44a3-9df3-4b5a84be39ad`), `AllViewerExceptHostHeader`
  (`b689b0a8-53d0-40ab-baf2-68738e2966ac`), `Compress: false`.
- The same function is associated as `viewer-request` on all three behaviors.

## Router source that worked

```js
import cf from 'cloudfront'

var kvs = cf.kvs()

var NOT_FOUND = {
  statusCode: 404,
  statusDescription: 'Not Found',
  headers: { 'content-type': { value: 'text/plain' }, 'cache-control': { value: 'no-store' } },
  body: 'no such preview\n',
}

async function handler(event) {
  var request = event.request
  var qs = request.querystring
  var p = qs.p && qs.p.value
  if (!p || !/^[0-9]+$/.test(p)) return NOT_FOUND

  // `await` may NOT appear inside a call's argument list — see Finding 1.
  var raw
  try {
    raw = await kvs.get('pr-' + p)
  } catch (e) {
    return NOT_FOUND
  }
  var route = JSON.parse(raw)

  var uri = request.uri
  if (uri === '/stream' || uri.indexOf('/stream/') === 0 || uri === '/echo' || uri.indexOf('/echo/') === 0) {
    cf.updateRequestOrigin({
      domainName: route.backend,
      originAccessControlConfig: {
        enabled: true,
        signingBehavior: 'always',
        signingProtocol: 'sigv4',
        originType: 'lambda',
      },
      customOriginConfig: { port: 443, protocol: 'https', sslProtocols: ['TLSv1.2'] },
      timeouts: { readTimeout: 60 },
      customHeaders: {},
    })
    return request
  }

  if (uri.slice(-1) === '/') uri = uri + 'index.html'
  else if (uri.lastIndexOf('.') <= uri.lastIndexOf('/')) uri = uri + '/index.html'
  request.uri = route.assets + uri
  return request
}
```

`ComputeUtilization` on the asset path: **8** (out of 100). The whole 10 KB / CPU budget is a
non-issue at this shape.

## Result 1 — D1: OAC on a dynamically selected function URL

The Lambda URL is `AWS_IAM`-authed and is **not** listed as an origin on the distribution. The
only thing telling CloudFront to sign is the inline `originAccessControlConfig` in the function.

```
$ curl -N -sS "https://d2m7c98qe0u10h.cloudfront.net/stream?p=1"     # timestamps added by a python filter
       0ms  event: tick
       0ms  data: {"i":1,"at":1788730586326}
     438ms  event: tick
     939ms  event: tick
    1440ms  event: tick
    1941ms  event: tick
    1941ms  event: done
```

Signing works, and CloudFront **does not buffer**: five events emitted 500 ms apart arrive
500 ms apart, 1941 ms of spread end to end. That is the same assertion `e2e/sse.spec.ts` makes
(≥ 400 ms 1st→5th, ≤ 1500 ms 1st→2nd) and it passes with ~5x margin.

POST with a body, the case that 403s under OAC when the client gets it wrong:

```
$ BODY='{"text":"hello preview"}'
$ H=$(printf '%s' "$BODY" | shasum -a 256 | cut -d' ' -f1)
$ curl -X POST .../echo?p=1 -H "x-amz-content-sha256: $H" -d "$BODY"
{"echo":"{\"text\":\"hello preview\"}","length":24}          status=200
$ # same request, hash of the wrong bytes
                                                             status=403
$ # same request, header omitted entirely
                                                             status=403
```

Exactly what `plan.md` predicted, and why `/api/echo` is a POST with a body in the e2e suite.

## Result 2 — D10: the rewritten URI is in the cache key

`pr-1/index.html` and `pr-2/index.html` hold different bodies. The viewer path is `/` in both
cases, and the cache policy has **no query strings in the key** — so the *only* thing that can
distinguish the two requests is the URI the function rewrote.

```
$ curl "$D/?p=1"   → <div id="root">PR ONE BODY</div>   200
$ curl "$D/?p=2"   → <div id="root">PR TWO BODY</div>   200
$ curl "$D/?p=1"   → PR ONE BODY   x-cache: Hit from cloudfront
$ curl "$D/?p=2"   → PR TWO BODY   x-cache: Hit from cloudfront
$ curl "$D/"       → 404   (no p)
$ curl "$D/?p=999" → 404   (no KVS key)
```

Both prefixes served **from cache**, each with its own body. D10 holds: one shared preview
bucket with a `pr-<n>/` prefix per PR is safe, `originPath` is not needed, and the fallback
(a bucket per PR) is not needed.

This is a stronger proof than the production shape would give. In production the hostname
differs between previews, and `Host` is in the cache key by default for a custom origin, so a
passing test would not distinguish "the URI is in the key" from "the Host is". Here nothing but
the rewritten URI varies.

## Findings not in the plan

**1. `await` cannot appear inside a call's argument list.** `JSON.parse(await kvs.get(k))` is
rejected at publish/test time with:

```
SyntaxError: await in arguments not supported in 20
```

It is a **syntax** error, so the function fails to run at all and every request through the
distribution returns `503 The CloudFront function ... is invalid or could not run` with no
useful detail at the edge. `aws cloudfront test-function` is the only thing that prints the
real message; run it before publishing. Bind the awaited value to a variable first.

**2. Both `lambda:InvokeFunctionUrl` *and* `lambda:InvokeFunction` are required.** Measured
directly, each transition given 20–30 s to propagate and the baseline re-confirmed afterwards
so the result is not propagation lag:

| Grants to `cloudfront.amazonaws.com` (SourceArn = distribution) | Result |
| --- | --- |
| `InvokeFunctionUrl` + `InvokeFunction` | **200** |
| `InvokeFunctionUrl` only | **403** |
| `InvokeFunction` only | **403** |
| both restored | **200** |

The plan already said to grant both (carried over from yahn); this is the measurement behind it.
Granting only the "obvious" one is a silent 403 with no CloudWatch signal on the Lambda side.

**3. `origin-placeholder.invalid` is accepted as an origin domain name.** The behaviors whose
origin the function always overrides still need *some* origin on the distribution. CloudFront
performs no resolvability check at `CreateDistribution`, so a deliberately unresolvable
`.invalid` domain is legal and gives the right failure mode: if the router ever fails to
override the origin, the request fails loudly instead of silently reaching a real host.

**4. A KVS cannot be associated with a function until it is `READY`.** `CreateFunction` with a
`KeyValueStoreAssociations` pointing at a `PROVISIONING` store fails with
`InvalidArgument: ... cannot be associated before the resource is provisioned`. Provisioning
took ~35 s here. CDK's `KeyValueStore` L2 handles the ordering, but any CLI or custom-resource
path must poll `describe-key-value-store` for `READY` first.

## Two KVS data-plane facts, measured against the spike store

`plan.md` D2 inferred the ETag-mismatch error code and left "delete of a missing key" as an
assumption the handler had to defend against. Both are now measured, against the real API:

```
$ aws cloudfront-keyvaluestore update-keys --if-match <current etag> --deletes '[{"Key":"pr-does-not-exist"}]'
{ "ETag": "KV3UN6WX5RRO2AG", "ItemCount": 2, "TotalSizeInBytes": 190 }      # success, nothing changed

$ aws cloudfront-keyvaluestore update-keys --if-match STALEETAG12345 --puts '[{"Key":"pr-3","Value":"{}"}]'
An error occurred (ValidationException) ... Pre-Condition failed during update of Key-Value-Store
```

- **Deleting a key that does not exist succeeds.** The handler's Delete path needs no
  pre-check, and a stack delete cannot wedge on a key someone already swept.
- **A stale ETag is a `ValidationException`, not a `ConflictException`** — the wording matches
  what SST retries on. The handler retries on both anyway, since the mapping is undocumented
  and AWS is free to change it.

## Teardown

All spike resources were deleted in the same session. For the record, the order that works
(CloudFront requires a distribution to be disabled *and* deployed before it can be deleted):

```
aws cloudfront update-distribution --id <id> --if-match <etag> --distribution-config <config with Enabled:false>
aws cloudfront wait distribution-deployed --id <id>
aws cloudfront delete-distribution --id <id> --if-match <new etag>
aws cloudfront delete-function --name cdk-core-spike-router --if-match <etag>
aws cloudfront delete-key-value-store --name cdk-core-spike --if-match <etag>
aws cloudfront delete-origin-access-control --id E24UT7LJQSHBID --if-match <etag>
aws lambda delete-function --function-name cdk-core-spike-stream
aws iam detach-role-policy --role-name cdk-core-spike-lambda --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
aws iam delete-role --role-name cdk-core-spike-lambda
aws s3 rm s3://cdk-core-spike-assets-063257577013 --recursive && aws s3api delete-bucket --bucket cdk-core-spike-assets-063257577013
```

A function cannot be deleted while a distribution still references it, so the distribution goes
first. Everything above is region `us-east-1`, profile `admin`.
