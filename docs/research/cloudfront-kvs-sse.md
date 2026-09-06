# CloudFront PR-preview routing: verified research

**Research performed: 2026-09-06.** Every claim below is sourced to a page I actually fetched during this session. Where the official docs are silent or ambiguous, I say so explicitly rather than filling the gap from memory.

Versions/artifacts checked live:
- `aws-cdk-lib@2.268.0` (installed from npm during this session; type declarations inspected directly)
- CloudFront Developer Guide, CloudFront API Reference, Lambda Developer Guide, API Gateway Developer Guide as served on 2026-09-06

---

# A. CloudFront Functions origin selection

## A1. Can a viewer-request CloudFront Function change the ORIGIN?

**Verdict: YES — fully supported today, and it has been since 2024-11-21.** Origin selection is *no longer* Lambda@Edge-only. There are three helper methods, all viewer-request-only, in the `cloudfront` built-in module under JavaScript runtime 2.0. Critically for your use case, `updateRequestOrigin()` can point at **an origin that is not defined in the distribution at all**, and it can set OAC config including `originType: "s3"` or `originType: "lambda"`.

### Launch dates

> "**Posted Date:** November 21, 2024
>
> 'Amazon CloudFront now supports origin modification within CloudFront Functions, enabling you to conditionally change or update origin servers on each request.'"
>
> — https://aws.amazon.com/about-aws/whats-new/2024/11/amazon-cloudfront-origin-modifications-cloudfront-functions/

Follow-ups (both verified as real AWS What's New posts via search result URLs on aws.amazon.com):
- 2025-04-02 — VPC origin modification with CloudFront Functions: https://aws.amazon.com/about-aws/whats-new/2025/04/amazon-cloudfront-vpc-origin-modification-functions
- 2025-11-20 — "3 new CloudFront Functions capabilities":
  > "**Posted Date:** November 20, 2025
  >
  > 'Amazon CloudFront now supports three new capabilities for CloudFront Functions: edge location and Regional Edge Cache (REC) metadata, raw query string retrieval, and advanced origin overrides.'"
  >
  > Advanced origin overrides "customize SSL/TLS handshake parameters, including Server Name Indication (SNI)."
  >
  > — https://aws.amazon.com/about-aws/whats-new/2025/11/amazon-cloudfront-3-functions-capabilities/

### Event type — viewer request only

> "This section applies if you dynamically update or change the origin used on the request inside your CloudFront Functions code. **You can update the origin on *viewer request* CloudFront Functions only.** CloudFront Functions has a module that provides helper methods to dynamically update or change the origin."
>
> "To use this module, create a CloudFront function using JavaScript runtime 2.0 and include the following statement in the first line of the function code:
> ```
> import cf from 'cloudfront';
> ```"
>
> — https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/helper-functions-origin-modification.html

Same page, on the CloudFront Functions vs Lambda@Edge tradeoff:

> "When using CloudFront Functions to update origins, you use the *viewer request* event trigger, which means this logic will run on every request when this function is used. When using Lambda@Edge, the origin updating capabilities are on the *origin request* event trigger, which means this logic only runs on cache misses."
>
> "CloudFront Functions is most useful in the following situations: When your requests are dynamic (meaning they cannot be cached) and will always go to origin. CloudFront Functions provides better performance and lower overall cost."

### The three helper methods

**1. `cf.updateRequestOrigin({...})`** — the one you want.

> "Use the `updateRequestOrigin()` method to update the origin settings for a request. You can use this method to update existing origin properties for origins that are already defined in your distribution, **or to define a new origin for the request**. To do so, specify the properties that you want to change."
>
> "**Important** — Any settings that you don't specify in the `updateRequestOrigin()` will inherit the *same settings* from the existing origin's configuration."
>
> "**The origin set by the `updateRequestOrigin()` method can be any HTTP endpoint and doesn't need to be an existing origin within your CloudFront distribution.**"

This is the key fact for PR previews: **you do not need to add an origin to the distribution per PR.**

**2. `cf.selectRequestOriginById(origin_id, {origin_overrides})`**

> "Use `selectRequestOriginById()` to update an existing origin by selecting a different origin that's already configured in your distribution. This method uses all the same settings that are defined by the updated origin."
>
> "This method only accepts origins that are already defined in the same distribution used when running the function. Origins are referenced by the origin ID, which is the origin name that you defined when setting up the origin."

**3. `cf.createRequestOriginGroup({originIds, failoverCriteria, selectionCriteria})`** — dynamic failover groups from origins already in the distribution.

### Full settable field list for `updateRequestOrigin()`

All quoted verbatim from https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/helper-functions-origin-modification.html:

| Field | Notes (verbatim excerpts) |
|---|---|
| `domainName` (optional) | Custom: "Specify a DNS domain name, such as `www.example.com`. The domain name can't include a colon (`:`) and can't be an IP address. The domain name can be up to 253 characters." S3: "Specify the DNS domain name of the Amazon S3 bucket, such as `amzn-s3-demo-bucket.s3.eu-west-1.amazonaws.com`. The name can be up to 128 characters, and must be all lowercase." |
| `hostHeader` (optional, non-S3) | "The host header to use when making the request to the origin. If this is not provided, the value from the domainName parameter is used." |
| `originPath` (optional) | "The directory path at the origin where the request should locate content. The path should start with a forward slash (/) but shouldn't end with one." Custom origins: "The path should be URL encoded and have a maximum length of 255 characters." |
| `customHeaders` (optional) | "`{"key1": "value1", "key2": "value2", ...}`" — "Header name must be lowercase in your function code." "You can't add headers that are disallowed, and a header with the same name can't also be present in the incoming request `headers`." An empty object `{}` "resets any header configured on the assigned origin". |
| `connectionAttempts` (optional) | "The minimum is 1 and the maximum is 3." |
| `originShield` (optional) | `enabled` (bool, required), `region` (required when enabled). |
| `originAccessControlConfig` (optional) | `enabled` (bool, required); `signingBehavior` — `always` \| `never` \| `no-override`; `signingProtocol` — "The only valid value is `sigv4`"; `originType` — "Valid values include `s3`, `mediapackagev2`, `mediastore`, and `lambda`." |
| `timeouts` (optional) | `readTimeout` (1–120 s), `responseCompletionTimeout`, `keepAliveTimeout` (1–120 s, custom origins only), `connectionTimeout` (1–10 s). |
| `customOriginConfig` (optional) | `port` (required), `protocol` (`http`/`https`, required), `sslProtocols` (required), `ipAddressType` (`ipv4`/`ipv6`/`dualstack`) — "Changing `ipAddressType` is only supported when the `domainName` property is also being changed." |
| `sni` (optional, non-S3) | Falls back to `hostHeader`, then `domainName`. |
| `allowedCertificateNames` (optional, non-S3) | "You can specify up to 20 allowed certificate names. Each certificate name can have up to 64 characters." |

### Can it change origin *type* (S3 ↔ custom ↔ Lambda function URL)?

**Yes.** The doc's own example switches to an S3 bucket with OAC:

> ```
> cf.updateRequestOrigin({
>     "domainName" : "amzn-s3-demo-bucket-in-us-east-1.s3.us-east-1.amazonaws.com",
>     "originAccessControlConfig": {
>         "enabled": true,
>         "signingBehavior": "always",
>         "signingProtocol": "sigv4",
>         "originType": "s3"
>     },
>     // Empty object resets any header configured on the assigned origin
>     "customHeaders": {}
> });
> ```

and the explicit caveat:

> "If you are changing the origin type and have OAC enabled, make sure that the origin type in `originAccessControlConfig` matches the new origin type."

Since `originType` accepts `lambda`, switching between an S3 origin and a Lambda function URL origin within one function is supported by the documented API surface. `customOriginConfig` exists precisely for "origins that are *not* an Amazon S3 bucket."

### Does OAC signing still work when you change the S3 bucket?

**Partially verifiable — flagging an ambiguity.** The doc says OAC config is applied inline (`enabled`/`signingBehavior`/`signingProtocol`/`originType`), and the example demonstrates enabling OAC on a newly specified bucket. However, the parameter description is worded oddly:

> "**originAccessControlConfig (optional)** — The unique identifier of an origin access control (OAC) for this origin. This is only used when the origin supports a CloudFront OAC, such as Amazon S3, Lambda function URLs, MediaStore, and MediaPackage V2. If this is not provided, then the OAC settings from the assigned origin are used."

It calls the field "the unique identifier of an OAC" but the sub-fields contain no OAC ID. **I could not find any doc statement about whether the target S3 bucket's bucket policy must independently grant `cloudfront.amazonaws.com` with a `AWS:SourceArn` condition for the distribution.** Given how OAC works everywhere else, it almost certainly must — but that is inference, not a cited fact. **Test this before committing the design.**

Also note the same page has no statement about whether `Distributions per origin access control` (default 100) applies when the OAC is specified inline by a function.

### Documented limitations

> "If you're updating an origin that is part of an origin group, only the *primary origin* of the origin group is updated. The secondary origin remains unchanged."
>
> "**You can't use the `updateRequestOrigin()` method to update [VPC origins]. The request will fail.**" (Use `selectRequestOriginById()` for VPC origins.)
>
> "The Test API and Test console pages don't test whether an origin modification has occurred. However, testing ensures that the function code executes without error."

Note also that `Origins per distribution` is 100 by default (adjustable) — https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-limits.html — which is exactly why the "origin need not be in the distribution" property matters for a PR-preview fleet.

---

## A2. Can the same function also rewrite `request.uri`?

**Verdict: YES — but with a gotcha that matters a lot for your design.**

> "**`uri`** — The relative path of the requested object.
> If your function modifies the `uri` value, the following applies:
> + The new `uri` value must begin with a forward slash (`/`).
> + When a function changes the `uri` value, it changes the object that the viewer is requesting.
> + **When a function changes the `uri` value, it *doesn't* change the cache behavior for the request or the origin that an origin request is sent to.**"
>
> "**`method`** — The HTTP method of the request. If your function code returns a `request`, it can't modify this field. **This is the only read-only field in the `request` object.**"
>
> — https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/functions-event-structure.html

**Design implications:**
1. `uri`, `querystring`, `headers`, `cookies` are all mutable in viewer-request; only `method` is read-only. So `request.uri = '/pr-123' + request.uri` works.
2. Cache-behavior selection happens on the *original* URI, before your function runs. Path-pattern based `additionalBehaviors` cannot be steered by the function. If you need different behaviors for `/api/*` vs static, the *viewer's* path must already distinguish them.
3. For the S3 prefix you have **two options**, and `originPath` is the cleaner one:
   - `updateRequestOrigin({ originPath: "/pr-123" })` — CloudFront prepends the path at the origin. Per https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/DownloadDistValuesOrigin.html: "CloudFront appends the directory path to the value of **Origin domain**… When a user enters `example.com/index.html` in a browser, CloudFront sends a request to Amazon S3 for `amzn-s3-demo-bucket/production/index.html`." Max 255 chars for custom origins.
   - Rewriting `request.uri` directly — also works, but the rewritten URI becomes part of the request as seen by the origin.
4. CloudFront Functions **cannot read the request body**: "CloudFront Functions can't access the body of the HTTP request." — https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-function-restrictions.html

---

## A3. CloudFront Functions limits, missing JS features, `cf.kvs()`, CDK association

### Quotas (verbatim from https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-limits.html)

| Entity | Default quota |
|---|---|
| Functions per AWS account | 100 |
| Maximum function size — "This quota isn't adjustable. To store additional data for your CloudFront Functions, create a key value store and add your key-value pairs." | **10 KB** |
| Maximum function memory | **2 MB** |
| Distributions associated with the same function | 100 |

### Max execution time — **NOT published as an absolute number**

> "CloudFront Functions have a limit on the time they can take to run, measured as *compute utilization*. Compute utilization is a number between 0 and 100 that indicates the amount of time that the function took to run as a percentage of the maximum allowed time. For example, a compute utilization of 35 means that the function completed in 35% of the maximum allowed time."
>
> — https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-function-restrictions.html

**Explicit caveat:** AWS does *not* publish the absolute millisecond ceiling anywhere I could find. The "sub-millisecond" figure that circulates is from marketing copy and third-party blogs, not the quota tables. The `Function timeout for a viewer request and response event: 5 Seconds` / `Function timeout (Origin request and response event): 30 Seconds` entries in https://docs.aws.amazon.com/general/latest/gr/cf_region.html are **Lambda@Edge** quotas, not CloudFront Functions. Budget by watching the `ComputeUtilization` CloudWatch metric, not by a clock.

### Restricted runtime features (verbatim, https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/functions-javascript-runtime-20.html "Restricted features")

> "**Dynamic code evaluation** — Dynamic code evaluation is not supported. Both `eval()` and `Function` constructors throw an error if attempted."
>
> "**Timers** — The `setTimeout()`, `setImmediate()`, and `clearTimeout()` functions are not supported. There is no provision to defer or yield within a function run. **Your function must synchronously run to completion.**"
>
> "**Date and timestamps** — For security reasons, there is no access to high-resolution timers. All `Date` methods to query the current time always return the same value during the lifetime of a single function run… Consequently, you cannot measure elapsed time in your function."
>
> "**File system access** — There is no file system access. For example, there is no `fs` module…"
>
> "**Process access** — There is no process access…"
>
> "**Environment variables** — There is no access to environment variables. Instead, you can use CloudFront KeyValueStore…"
>
> "**Network access** — There is no support for network calls. For example, XHR, HTTP(S), and socket are not supported."

**Correction to a common assumption:** `async`/`await` **ARE supported** in runtime 2.0.

> "The following ES 8 statements are supported: `async`, `await`. `async`, `await`, `const`, and `let` are supported in JavaScript runtime 2.0. `await` can be used inside `async` functions only. **`async` arguments and closures are not supported.**"

Also supported in 2.0: `Promise.all/allSettled/any/race/reject/resolve`, template literals, arrow functions, rest params, `String.prototype.replaceAll()`, `atob()`/`btoa()`, `globalThis`, typed arrays, `DataView`, `TextEncoder`/`TextDecoder`, and built-in modules `buffer`, `querystring`, `crypto` (`md5`/`sha1`/`sha256` hash + HMAC). `console.log()` only — "CloudFront Functions doesn't support comma syntax, such as `console.log('a', 'b')`."

Runtime baseline: "compliant with ECMAScript (ES) version 5.1 and also supports some features of ES versions 6 through 12." "Functions operate in strict mode by default."

`fetch` is **not** available (network access is blocked).

### `cf.kvs()` API (verbatim, https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/functions-custom-methods.html)

Setup:
> ```
> import cf from 'cloudfront';
> const kvsHandle = cf.kvs();
> ```

**`get()`**
> "`get("{{key}}", {{options}});`
> + `key`: The name of the key whose value needs to be fetched
> + `options`: There is one option, `format`. It ensures that the function parses the data correctly. Possible values:
>   + `string`: (Default) UTF8 encoded
>   + `json`
>   + `bytes`: Raw binary data buffer"
>
> "`const value = await kvsHandle.get("myFunctionKey", { format: "string"});`"
>
> "The response is a `promise` that resolves to a value in the format requested"
>
> "**Error handling** — The `get()` method will return an error when the key that you requested doesn't exist in the associated key value store. To manage this use case, you can add a `try` and `catch` block to your code."

**Critical performance/memory warning — directly relevant to a KVS-lookup router:**
> "**Warning** — Using promise combinators (for example, `Promise.all`, `Promise.any`, and promise chain methods (for example, `then` and `catch`) can require high function memory usage. If your function exceeds the maximum function memory quota, it will fail to execute. To avoid this error, we recommend that you use the `await` syntax sequentially or in loops to request multiple values."
>
> "Currently, using promise combinators to get multiple values won't improve performance."

So: `await kvsHandle.get(host)` sequentially. Do not `Promise.all` your lookups.

**`exists()`**
> "`const exist = await kvsHandle.exists("myFunctionkey");`" → "a `promise` that returns a Boolean (`true` or `false`)."

**`meta()`**
> "`const meta = await kvsHandle.meta();`" → resolves to:
> + "`creationDateTime`: The date and time that the key value store was created, in ISO 8601 format."
> + "`lastUpdatedDateTime`: The date and time that the key value store was last synced from the source, in ISO 8601 format. **The value doesn't include the propagation time to the edge.**"
> + "`keyCount`: The total number of keys in the KVS after the last sync from the source."

Also: "Key value store helper method calls from CloudFront Functions don't trigger an AWS CloudTrail data event."

### CDK association — confirmed present

Confirmed in **aws-cdk-lib 2.268.0** (I installed it and read `aws-cloudfront/lib/function.d.ts` directly):

```ts
/**
 * The Key Value Store to associate with this function.
 *
 * In order to associate a Key Value Store, the `runtime` must be
 * cloudfront-js-2.0 or newer.
 *
 * @default - no key value store is associated
 */
readonly keyValueStore?: IKeyValueStoreRef;

/**
 * @default FunctionRuntime.JS_1_0 (unless `keyValueStore` is specified, then `FunctionRuntime.JS_2_0`)
 */
readonly runtime?: FunctionRuntime;
```

Matching CDK API reference page — https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_cloudfront.Function.html:
> "**keyValueStore?** — `IKeyValueStoreRef` — The Key Value Store to associate with this function. *(optional, default: no key value store is associated)*"
> "The Key Value Store to associate with this function. In order to associate a Key Value Store, the `runtime` must be `cloudfront-js-2.0` or newer."
> "**runtime?** — `FunctionRuntime` — *(optional, default: FunctionRuntime.JS_1_0 (unless `keyValueStore` is specified, then `FunctionRuntime.JS_2_0`))*"

`FunctionRuntime.JS_1_0` ("cloudfront-js-1.0") and `FunctionRuntime.JS_2_0` ("cloudfront-js-2.0") both exist as static members. **CDK auto-upgrades the runtime to JS 2.0 when you pass `keyValueStore`**, so you don't have to set it manually.

---

# B. CloudFront KeyValueStore limits & concurrency

## B4. Sizes, counts, propagation

**Verdict: 5 MB per store, 512 B keys, 1 KB values, 1 store per function, 200 stores per account. Max *number of keys* is NOT documented — it is implicitly bounded by the 5 MB total.**

Verbatim from https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-limits.html ("Quotas on key value stores"):

| Entity | Default quota |
|---|---|
| Maximum size of a key in a key-value pair | **512 Bytes** |
| Maximum size of the value in a key-value pair | **1 KB** |
| Maximum key values pairs that you can update in a single API request | **50 keys or 3 MB payload, whichever is reached first** |
| Maximum size of an individual key value store | **5 MB** |
| Maximum number of functions that a single key value store can be associated with | **100** |
| Maximum number of key value stores per function | **1** |
| Maximum number of key value stores per account | **200** (adjustable) |

**Explicitly not documented:** there is no "maximum number of keys per store" row. The binding constraint is the 5 MB total. For `pr-N.preview.example.com` → small JSON value, budget roughly: a 30-byte key + a ~200-byte JSON value ≈ 230 B → on the order of ~20k PRs before you hit 5 MB. That is arithmetic on the documented quotas, not an AWS-stated number.

**Stores-per-function = 1** is confirmed twice:
> "A function can have only one key value store. You can associate the same key value store with multiple functions."
>
> — https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/kvs-with-functions-associate.html

**Propagation time — soft statement only, no SLA:**
> "When you update a key value store, changes are propagated to all CloudFront edge locations **in a few seconds** so that it can be used with low latency by the functions."
>
> — https://aws.amazon.com/blogs/aws/introducing-amazon-cloudfront-keyvaluestore-a-low-latency-datastore-for-cloudfront-functions/ (posted 2023-11-21)

I could **not** find any propagation-time statement in the Developer Guide itself, nor any SLA. Treat "a few seconds" as a blog-level assertion. The only in-product signal is `meta().lastUpdatedDateTime`, and the docs warn it "doesn't include the propagation time to the edge." **For a PR-preview flow this means: after your CI writes the KVS key, there is an unspecified (seconds-scale) window during which `pr-123.preview.example.com` may still 404 or route to a stale origin.** Build a retry/poll into your deploy step rather than assuming immediate visibility.

Also note the runtime gate: "To use CloudFront KeyValueStore, your CloudFront function must use JavaScript runtime 2.0."

## B5. Write API, `IfMatch` ETag, error on mismatch, rate limits

**Verdict: `IfMatch` is REQUIRED on every mutating call. Mismatch almost certainly surfaces as `ConflictException` (HTTP 409), but the docs never say so in words — that is an inference from the error list. Write rate limits are NOT documented anywhere I could find.**

Operations (https://docs.aws.amazon.com/cloudfront/latest/APIReference/API_Operations_Amazon_CloudFront_KeyValueStore.html):
> "The following actions are supported by Amazon CloudFront KeyValueStore: `DeleteKey`, `DescribeKeyValueStore`, `GetKey`, `ListKeys`, `PutKey`, `UpdateKeys`"

**`PutKey`** — https://docs.aws.amazon.com/cloudfront/latest/APIReference/API_kvs_PutKey.html
> ```
> PUT /key-value-stores/{{KvsARN}}/keys/{{Key}} HTTP/1.1
> If-Match: {{IfMatch}}
> Content-type: application/json
>
> { "Value": "{{string}}" }
> ```
>
> "**IfMatch** — The current version (`ETag`) of the key value store that you are putting keys into, which you can get by using the `DescribeKeyValueStore` API operation. **Required: Yes**"
>
> "**Key** — The key to put. Length Constraints: Minimum length of 1. **Maximum length of 1024.** Required: Yes"

(Note the API-level `Key` length constraint of 1024 conflicts with the quota page's "Maximum size of a key in a key-value pair: 512 Bytes". **Documented conflict — treat 512 bytes as the operative limit.**)

Response:
> ```
> HTTP/1.1 200
> ETag: {{ETag}}
> { "ItemCount": number, "TotalSizeInBytes": number }
> ```
> "**ETag** — The current version identifier of the key value store after the successful put."

**`UpdateKeys`** — https://docs.aws.amazon.com/cloudfront/latest/APIReference/API_kvs_UpdateKeys.html
> "**Puts or deletes multiple key-value pairs in a single, all-or-nothing operation.**"
> ```
> POST /key-value-stores/{{KvsARN}}/keys HTTP/1.1
> If-Match: {{IfMatch}}
> { "Deletes": [ { "Key": "{{string}}" } ],
>   "Puts":    [ { "Key": "{{string}}", "Value": "{{string}}" } ] }
> ```
> "**IfMatch** — The current version (`ETag`) of the key value store that you are updating keys of, which you can get by using the `DescribeKeyValueStore` API operation. **Required: Yes**"

Also returns a fresh `ETag`.

**Errors (identical set on `PutKey` and `UpdateKeys`):**
> "**AccessDeniedException** — Access denied. HTTP Status Code: 403
> **ConflictException** — Resource is not in expected state. HTTP Status Code: 409
> **InternalServerException** — Internal server error. HTTP Status Code: 500
> **ResourceNotFoundException** — Resource was not found. HTTP Status Code: 404
> **ServiceQuotaExceededException** — Limit exceeded. HTTP Status Code: 402
> **ValidationException** — Validation failed. HTTP Status Code: 400"

**Explicit uncertainty:** neither page says "an `IfMatch` that does not match the current ETag returns X." `ConflictException` / 409 ("Resource is not in expected state") is the only error whose description fits an optimistic-concurrency failure, and 409 is the conventional HTTP code for it. `ValidationException`/400 is the plausible alternative if the header is malformed. **Handle both** in your retry logic rather than matching on one.

Also note: there is **no `ThrottlingException`** in the documented error list for these operations, which is itself notable.

### Optimistic-concurrency implications for two racing writers

The design is *store-level*, not key-level: the `ETag` versions the **entire key value store**, and `DescribeKeyValueStore` returns it. Consequences for a PR-preview pipeline where many CI jobs write concurrently:

1. **Any successful write to the store invalidates every other writer's ETag** — even writes to unrelated keys. Two PRs deploying simultaneously will conflict with each other even though they touch different keys.
2. The correct loop is: `DescribeKeyValueStore` → get ETag → `PutKey`/`UpdateKeys` with `If-Match` → on conflict, re-describe and retry with exponential backoff + jitter.
3. `UpdateKeys` is "a single, all-or-nothing operation" — batch a PR's keys into one call (up to "50 keys or 3 MB payload") to shrink the conflict window.
4. Under high concurrency this can livelock. If your CI fan-out is wide, serialize KVS writes behind a single writer (e.g., an SQS FIFO queue or a Lambda with reserved concurrency 1) rather than letting N jobs race.

### Write rate limits — NOT DOCUMENTED

I checked both quota sources:
- https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-limits.html — "Quotas on key value stores" has **no** requests-per-second row.
- https://docs.aws.amazon.com/general/latest/gr/cf_region.html — the CloudFront Service Quotas table has **no** KeyValueStore API rate entry at all.

**Verdict: AWS does not publish a KVS write TPS limit.** Assume one exists and implement backoff regardless. (The `$1 per 1,000 API requests` pricing below is itself a strong hint that this API is not intended for high-frequency writes.)

### STS gotcha for the write API — easy to miss

> "To call the CloudFront KeyValueStore API, use a *Regional* endpoint in AWS STS to return a *version 2* session token. If you use the *global* endpoint for AWS STS (`sts.amazonaws.com`), AWS STS will generate a *version 1* session token, **which isn't supported by Signature Version 4A (SigV4A). As a result, you will receive an authentication error.**"
>
> — https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-function-restrictions.html

This bites CI runners using assumed roles with older SDK configs. Fix via regional STS endpoints, or `aws iam set-security-token-service-preferences --global-endpoint-token-version v2Token`.

Endpoint (https://docs.aws.amazon.com/general/latest/gr/cf_region.html): "CloudFront KeyValueStore is a global service. Specify your AWS account ID for the endpoint." → `{{AWS account}}.cloudfront-kvs.global.api.aws`

## B6. Key listing

**Verdict: YES — `ListKeys` exists, is paginated, and returns values too. Max page size 50.**

> "**ListKeys** — Returns a list of key-value pairs.
> ```
> GET /key-value-stores/{{KvsARN}}/keys?MaxResults={{MaxResults}}&NextToken={{NextToken}} HTTP/1.1
> ```
>
> "**MaxResults** — Maximum number of results that are returned per call. **The default is 10 and maximum allowed page is 50.** Valid Range: Minimum value of 1. Maximum value of 50."
>
> "**NextToken** — If `nextToken` is returned in the response, there are more results available. Make the next call using the returned token to retrieve the next page."
>
> Response: `{ "Items": [ { "Key": "string", "Value": "string" } ], "NextToken": "string" }`
>
> — https://docs.aws.amazon.com/cloudfront/latest/APIReference/API_kvs_ListKeys.html

Note `Items` includes **both key and value** — so a full listing is a full store dump. There is **no** prefix-filter or query parameter. Enumerating ~1000 PR keys = ~20 paginated calls, each billed as an API request ($1/1000). Cheap, but not free — cache the listing if you build a "list active previews" endpoint.

`GetKey` also exists for single-key reads outside a function.

## B7. Pricing

**Verdict: CloudFront Functions $0.10/M invocations; KVS reads-in-function $0.03/M; KVS API operations $1 per 1,000 requests (i.e. writes/lists are ~33,000× more expensive per-op than in-function reads). Both have a 2M/month free tier. KVS is NOT free.**

From https://aws.amazon.com/cloudfront/pricing/pay-as-you-go/:

> **CloudFront Functions:** "Invocation pricing is $0.10 per 1 million invocations" with 2 million invocations included monthly in the free tier.
>
> **CloudFront KeyValueStore:** Reads within functions cost "$0.03 per 1 million reads," while other API actions are "$1 per 1,000 API requests." The free tier includes 2 million monthly reads.
>
> **Lambda@Edge:** Request charges "$0.60 per 1 million requests." Duration "$0.00005001 for every GB-second used," metered at 1-millisecond granularity. **No complimentary tier applies to this service.**
>
> **Free Tier Includes (Monthly):** 1 TB data transfer out; 10,000,000 HTTP/HTTPS requests; 2,000,000 CloudFront Function invocations; 2,000,000 KeyValueStore reads.

(Note: https://aws.amazon.com/cloudfront/pricing/ now leads with **flat-rate plans** — Free / Pro $15 / Business $200 / Premium $1,000 per month per distribution — and lists "Serverless edge compute" as an included feature without itemizing. The per-unit numbers above are on the pay-as-you-go sub-page.)

Also confirmed: the Nov 2024 origin-modification launch is "available at no additional cost," and the Nov 2025 three-capabilities launch is "available at no additional charge." OAC for Lambda function URLs is likewise "with no additional costs."

**Cost model for PR previews:** CloudFront Functions runs on **every request** (viewer-request), not just cache misses. At $0.10/M invocations + $0.03/M KVS reads = **$0.13 per million requests** of routing overhead. Lambda@Edge origin-request would be $0.60/M *plus duration* but only on cache misses. For preview environments (mostly uncacheable) CloudFront Functions wins decisively.

---

# C. SSE / streaming through CloudFront to Lambda

## C8. Response streaming: invoke modes, API Gateway status, function URL + OAC

**Verdict:**
- **Function URL:** set `InvokeMode: RESPONSE_STREAM`. Max streamed response is now **200 MB**, not 20 MB — that figure is out of date.
- **API Gateway REST APIs:** response streaming **IS now supported**, announced **2025-11-19**. HTTP APIs are **not** covered.
- **Lambda function URL as a direct CloudFront origin with OAC:** supported since **2024-04-11**; requires `AuthType: AWS_IAM`; POST/PUT bodies require the *client* to send `x-amz-content-sha256`.

### Function URL invoke modes

> "You can invoke response streaming enabled functions by changing the invoke mode of your function's URL… The available invoke modes are:
> + **`BUFFERED`** – This is the default option. Lambda invokes your function using the `Invoke` API operation. Invocation results are available when the payload is complete. **The maximum payload size is 6 MB.**
> + **`RESPONSE_STREAM`** – Enables your function to stream payload results as they become available. Lambda invokes your function using the `InvokeWithResponseStream` API operation. **The maximum response payload size is 200 MB.**"
>
> "Lambda streams all response payloads for invocations that come through the function's URL until you change the invoke mode to `BUFFERED`."
>
> CLI: `aws lambda update-function-url-config --function-name my-function --invoke-mode RESPONSE_STREAM`
> CFN: `Type: AWS::Lambda::Url` / `Properties: { AuthType: AWS_IAM, InvokeMode: RESPONSE_STREAM }`
>
> — https://docs.aws.amazon.com/lambda/latest/dg/config-rs-invoke-furls.html

Runtime constraint:
> "Lambda supports response streaming on **Node.js managed runtimes**. For other languages, including Python, you can use a custom runtime with a custom Runtime API integration to stream responses or use the Lambda Web Adapter."
>
> — https://docs.aws.amazon.com/lambda/latest/dg/configuration-response-streaming.html

Cost warning worth flagging for preview environments:
> "Streaming responses incur cost and **streamed responses are not interrupted or stopped when the invoking client connection is broken. Customers are billed for the full function duration**, so customers should exercise caution when configuring long function timeouts."

VPC constraint:
> "**Lambda function URLs do not support response streaming within a VPC environment.**"

Regional availability:
> "Lambda response streaming is not yet available in all AWS Regions."
>
> (Though https://aws.amazon.com/about-aws/whats-new/2026/04/aws-lambda-response-streaming announces expansion to all commercial Regions — I found the URL via search but did not fetch the page body, so treat the April 2026 all-Regions claim as **unverified**.)

### API Gateway response streaming — CONFIRMED, REST APIs only

> "**Posted Date:** November 19, 2025 — Coverage Scope: **REST APIs only**
>
> 'Amazon API Gateway now progressively streams response payloads to clients as they become available. This improves REST API responsiveness by eliminating the need to buffer complete responses before transmission.'
>
> Supported integration types: Lambda functions, HTTP proxy integrations, private integrations. The feature is explicitly limited to REST APIs and does not mention HTTP APIs support."
>
> — https://aws.amazon.com/about-aws/whats-new/2025/11/api-gateway-response-streaming-rest-apis/

Corroborated in the Lambda docs:
> "Your Lambda function can also stream response payloads through the **Amazon API Gateway proxy integration**, which uses the `InvokeWithResponseStream` API to invoke your function."
>
> — https://docs.aws.amazon.com/lambda/latest/dg/configuration-response-streaming.html

Mechanics — https://docs.aws.amazon.com/apigateway/latest/developerguide/response-transfer-mode-lambda.html:
> "API Gateway requires you to use the `InvokeWithResponseStream` Lambda API to invoke your Lambda function… In order for API Gateway to stream the Lambda output, the Lambda function must output the format required by API Gateway."
>
> "In a Lambda proxy integration, API Gateway sends the response to client only after it receives the full response from Lambda. **In a Lambda proxy integration for response streaming, API Gateway begins the payload stream after it receives the valid metadata and delimiter from Lambda.**"
>
> "The output expects the headers to contain either `Transfer-Encoding: chunked` or `Content-length: {{number}}`. **If your function doesn't return either of these headers, API Gateway appends `Transfer-Encoding: chunked` to the response header.**"
>
> "You must provide a delimiter after the metadata JSON. **The delimiter must be 8 null bytes and it must appear within the first 16KB of stream data.**"
>
> "**If you're using a function URL to stream your Lambda function, you must modify the input and the output of your Lambda function to satisfy these requirements.**"

That last line matters: **API Gateway streaming and function-URL streaming use incompatible Lambda output formats.** You cannot swap one for the other without changing handler code.

From the AWS Compute blog (https://aws.amazon.com/blogs/compute/building-responsive-apis-with-amazon-api-gateway-response-streaming/):
> Streaming supports "long-running operations while reporting incremental progress using protocols such as **server-sent events (SSE)**." Request timeouts "up to 15 minutes" when streaming is enabled. "When processing streamed responses, the following features are not supported: **response transformation with VTL, integration response caching, and content encoding.**" First 10 MB unthrottled, then 2 MB/s. New access log variable `$content.integration.responseTransferMode` (BUFFERED/STREAMED).

**Recommendation for your design:** the function-URL + OAC path is simpler and one fewer hop than API Gateway. Given per-PR backends, you'd need a per-PR API or per-PR stage otherwise. Function URL wins.

### CloudFront + Lambda function URL origin with OAC

Launch:
> "**Posted Date:** April 11, 2024 — 'Starting today, customers can protect their AWS Lambda URL origins by using CloudFront Origin Access Control (OAC) to only allow access from designated CloudFront distributions.'"
>
> — https://aws.amazon.com/about-aws/whats-new/2024/04/amazon-cloudfront-oac-lambda-function-url-origins/

**AWS_IAM is required — verbatim:**
> "Before you create and set up OAC, you must have a CloudFront distribution with a Lambda function URL as the origin. **To use OAC, you must specify `AWS_IAM` as the value for the `AuthType` parameter.**"
>
> — https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-lambda.html

**`x-amz-content-sha256` for POST/PUT — verbatim, and this is a hard blocker if your SSE endpoint uses POST:**
> "**Important** — If you use `PUT` or `POST` methods with your Lambda function URL, **your users must compute the SHA256 of the body and include the payload hash value of the request body in the `x-amz-content-sha256` header when sending the request to CloudFront. Lambda doesn't support unsigned payloads.**"

**This is a client-side requirement**, not something CloudFront can synthesize. The doc's example script computes `hashlib.sha256(body).hexdigest()` and sets `'x-amz-content-sha256': body_hash`. A plain browser `fetch()` POST will **not** do this. **Design consequence: if your SSE stream is opened with `POST` (as many LLM-chat clients do), you must add this header in your frontend client. If you use `GET` (standard `EventSource`), this requirement does not apply.** Strongly prefer `GET` + `EventSource` for the SSE endpoint.

Required IAM grant (both statements):
```
aws lambda add-permission --statement-id "AllowCloudFrontServicePrincipal" \
  --action "lambda:InvokeFunctionUrl" --principal "cloudfront.amazonaws.com" \
  --source-arn "arn:aws:cloudfront::123456789012:distribution/E1PDK09ESKHJWT" \
  --function-name FUNCTION_URL_NAME
aws lambda add-permission --statement-id "AllowCloudFrontServicePrincipalInvokeFunction" \
  --action "lambda:InvokeFunction" --principal "cloudfront.amazonaws.com" \
  --source-arn "arn:aws:cloudfront::123456789012:distribution/E1PDK09ESKHJWT" \
  --function-name FUNCTION_URL_NAME
```
> "**Note** — To update the IAM policy for the Lambda function URL, you must use the AWS Command Line Interface (AWS CLI). Editing the IAM policy in the Lambda console isn't supported at this time."

Also: "Select **HTTPS only** for your origin's **Protocol**."

**Does streaming work through CloudFront to a function URL?** Yes:
> "You can also configure CloudFront with a function URL as origin. When streaming responses through a function URL and CloudFront, you can have faster TTFB performance and return larger payload sizes."
>
> — https://aws.amazon.com/blogs/compute/introducing-aws-lambda-response-streaming/

(That same blog still says "There is an initial maximum response size of 20 MB, which is a soft limit you can increase" — **this is stale**. The current Lambda quotas page says 200 MB. See C9.)

**Per-PR scaling caveat I could not resolve:** `Distributions per origin access control` defaults to 100 (adjustable). With one OAC reused across all PR Lambda URLs and one distribution, you're fine. But the `--source-arn` condition on `lambda:InvokeFunctionUrl` is **per function**, so **every PR's Lambda needs its own `add-permission` call** at deploy time. Budget for that in your CI.

## C9. Does CloudFront buffer streaming responses? Timeouts for a multi-minute SSE stream

**Verdict: CloudFront does NOT buffer — it passes chunks through as they arrive. The binding timeout for SSE is the origin *response* (read) timeout: default 30 s, max 120 s, applied BETWEEN packets. There is NO total-response cap by default. So an SSE stream lasting hours is fine as long as the origin emits something at least every 30 s (or you raise the read timeout).**

### CloudFront streams chunked responses through — the definitive statement

> "**`Transfer-Encoding` header** — CloudFront supports only the `chunked` value of the `Transfer-Encoding` header. **If your origin returns `Transfer-Encoding: chunked`, CloudFront returns the object to the client as the object is received at the edge location**, and caches the object in chunked format for subsequent requests."
>
> "If the viewer makes a `Range GET` request and the origin returns `Transfer-Encoding: chunked`, CloudFront returns the entire object to the viewer instead of the requested range."
>
> "We recommend that you use chunked encoding if the content length of your response cannot be predetermined."
>
> — https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/RequestAndResponseBehaviorCustomOrigin.html

Corroborating, from the "Dropped TCP connections" section on the same page:
> "**Content-Length header** – CloudFront returns the object to the viewer **as it gets the object from your origin**."
> "**Transfer-Encoding: Chunked** – CloudFront returns the object to the viewer **as it gets the object from your origin**. However, if the chunked response is not complete, CloudFront does not cache the object."

CloudFront also normalizes the header outbound:
> "`Transfer-Encoding` – If your origin returns this header field, CloudFront sets the value to `chunked` before returning the response to the viewer."

**This directly contradicts the widespread claim that "CloudFront buffers streaming responses."** That folklore comes from misconfiguration — usually compression, or a too-short read timeout — not from CloudFront's transport behavior.

Note also: `HTTP version` — "CloudFront forwards requests to your custom origin using **HTTP/1.1**." (Viewer-side can be HTTP/2 or HTTP/3.)

### The timeouts, precisely

From https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/DownloadDistValuesOrigin.html:

**Response timeout (a.k.a. origin read timeout / origin request timeout) — THE ONE THAT MATTERS FOR SSE:**
> "The origin response timeout, also known as the *origin read timeout* or *origin request timeout*, applies to both of the following values:
> + How long (in seconds) CloudFront waits for a response after forwarding a request to the origin.
> + **How long (in seconds) CloudFront waits after receiving a packet of a response from the origin and before receiving the next packet.**"
>
> "`GET` and `HEAD` requests – If the origin doesn't respond or stops responding within the duration of the response timeout, CloudFront drops the connection. CloudFront tries again to connect according to the value of Connection attempts."
> "`DELETE`, `OPTIONS`, `PATCH`, `PUT`, and `POST` requests – If the origin doesn't respond for the duration of the read timeout, CloudFront drops the connection and doesn't try again to contact the origin."

**Response and keep-alive timeout quotas:**
> "For **response timeout**, the default is **30 seconds**."
> "For **keep-alive timeout**, the default is **5 seconds**."

Quota ranges (https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-limits.html):
| Setting | Range | Adjustable |
|---|---|---|
| Connection timeout per origin | 1–10 seconds | No |
| Connection attempts per origin | 1–3 | No |
| **Response timeout per origin** | **1–120 seconds** | **Yes** — Service Quotas `L-AECE9FA7` |
| Keep-alive timeout per origin | 1–300 seconds | Yes — `L-7429AF8A` |

(The general reference at https://docs.aws.amazon.com/general/latest/gr/cf_region.html lists "Response timeout per origin — Each supported Region: 120 Seconds — Yes" and "Keep-alive timeout … 120 Seconds — Yes". **Documented conflict:** the Developer Guide quota page says keep-alive max 300 s, the general reference says 120 s. Verify in Service Quotas for your account before relying on >120 s.)

**Response completion timeout — the total cap, and it is OFF by default:**
> "The time (in seconds) that a request from CloudFront to the origin can stay open and wait for a response. If the complete response isn't received from the origin by this time, CloudFront ends the connection."
>
> "Unlike **Response timeout**, which is the wait time for *individual* response packets, **Response completion timeout** is the *maximum* allowed amount of time that CloudFront waits for the response to complete."
>
> "**If you don't set a value for the response completion timeout, CloudFront doesn't enforce a maximum value.**"
>
> "If you set a value for response completion timeout, the value must be equal to or greater than the value for the response timeout."
>
> "**Note** — Response completion timeout doesn't support the continuous deployment feature."

### So: what applies to a multi-minute SSE stream?

**Answer: only the read timeout, between packets.** There is no total-duration cap unless you opt into `responseCompletionTimeout`. Therefore:

1. **Your origin must emit a byte at least every 30 seconds** (default read timeout), or CloudFront drops the connection. Standard SSE practice — a comment heartbeat `: keepalive\n\n` every 10–20 s — satisfies this.
2. If you cannot heartbeat, raise the response timeout to up to 120 s. Beyond 120 s requires a quota increase request (`L-AECE9FA7`).
3. **Do NOT set `responseCompletionTimeout`** on the SSE behavior. It defaults to unenforced, which is what you want. If you set it elsewhere in the distribution, make sure the SSE behavior's origin doesn't inherit it. Note you can set it per-request via `cf.updateRequestOrigin({ timeouts: { ... } })`.
4. A separate 10-minute idle cap exists but is **WebSocket-only**: "Origin response timeout (idle timeout) | 10 minutes | If CloudFront hasn't detected any bytes sent from the origin to the client within the past 10 minutes, the connection is assumed to be idle and is closed." (https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-limits.html, "Quotas on WebSocket connections"). This does **not** apply to SSE over plain HTTP.

### Lambda-side duration and byte limits

From https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html:
> "**Function timeout** — 900 seconds (15 minutes)"
> "**Invocation payload (request and response)** — 6 MB each for request and response (synchronous) / **200 MB for each streamed response (synchronous)** / 1 MB (asynchronous) / 1 MB for the total combined size of request line and header values"
> "**Bandwidth for streamed responses** — Uncapped for the first 6 MB of your function's response. For responses larger than 6 MB, **2 MBps** for the remainder of the response"
> "Code can run for up to 15 minutes in a single invocation"

> "The streaming rate for the first 6 MB of your function's response is uncapped. For responses larger than 6 MB, the remainder of the response is subject to a bandwidth cap… After this initial burst, Lambda streams your response at a maximum rate of **2 MBps**."
>
> — https://docs.aws.amazon.com/lambda/latest/dg/configuration-response-streaming.html

**On the "20 MB soft limit" you asked about: that number is OBSOLETE.** It appears in the 2023 launch blog ("There is an initial maximum response size of 20 MB, which is a soft limit you can increase") but the current quotas page and the current function-URL docs both say **200 MB**. Confirmed by https://aws.amazon.com/about-aws/whats-new/2025/07/aws-lambda-response-streaming-200-mb-payloads (found via search; body not fetched, so treat the July-2025 date as unverified — but the 200 MB figure is verified in two current doc pages).

**Practical ceiling for an SSE stream through this stack: 15 minutes (Lambda function timeout).** Not CloudFront. Design reconnect logic (`EventSource` auto-reconnects; send `Last-Event-ID`).

## C10. Cache policy / origin request policy for SSE; does CloudFront compress `text/event-stream`?

**Verdict: use `CachingDisabled` + `AllViewerExceptHostHeader`, and leave `Compress` OFF. CloudFront does NOT compress `text/event-stream` — it is absent from the compressible list, and SSE responses lack `Content-Length` anyway, which independently disqualifies them.**

### Compression: `text/event-stream` is NOT in the list

Verbatim, the **complete** list of compressible `Content-Type` values (https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/ServingCompressedFiles.html):

> `application/dash+xml`, `application/eot`, `application/font`, `application/font-sfnt`, `application/javascript`, `application/json`, `application/opentype`, `application/otf`, `application/pdf`, `application/pkcs7-mime`, `application/protobuf`, `application/rss+xml`, `application/truetype`, `application/ttf`, `application/vnd.apple.mpegurl`, `application/vnd.mapbox-vector-tile`, `application/vnd.ms-fontobject`, `application/wasm`, `application/xhtml+xml`, `application/xml`, `application/x-font-opentype`, `application/x-font-truetype`, `application/x-font-ttf`, `application/x-httpd-cgi`, `application/x-javascript`, `application/x-mpegurl`, `application/x-opentype`, `application/x-otf`, `application/x-perl`, `application/x-ttf`, `font/eot`, `font/opentype`, `font/otf`, `font/ttf`, `image/svg+xml`, `text/css`, `text/csv`, `text/html`, `text/javascript`, `text/js`, `text/plain`, `text/richtext`, `text/tab-separated-values`, `text/xml`, `text/x-component`, `text/x-java-source`, `text/x-script`, `vnd.apple.mpegurl`

**`text/event-stream` does not appear.** CloudFront will not compress it. Preamble: "If you configure CloudFront to compress objects, CloudFront only compresses objects that have one of the following values in the `Content-Type` response header."

Two further independent guards:
> "**`Content-Length` header** — The origin must include a `Content-Length` header in the response, which CloudFront uses to determine whether the size of the object is in the range that CloudFront compresses. **If the `Content-Length` header is missing**, contains an invalid value, or contains a value outside the range of sizes that CloudFront compresses, **CloudFront doesn't compress the object.**"
>
> "**Size of objects that CloudFront compresses** — CloudFront compresses objects that are between 1,000 bytes and 10,000,000 bytes in size."

An SSE response is chunked with no `Content-Length`, so even a hypothetically-listed content type wouldn't be compressed.

**But do turn `Compress` off anyway** on the SSE behavior. Reason, verbatim:
> "When CloudFront is configured to compress objects, **it includes the `Accept-Encoding` header in the cache key and in origin requests automatically.**"

That is a needless cache-key dimension on an uncacheable behavior. Also relevant: "If the `Accept-Encoding` header includes additional values such as `deflate`, CloudFront removes them before forwarding the request to the origin."

If your **origin** compresses SSE itself (some frameworks do), CloudFront passes it through untouched — "When a response from an origin includes the `Content-Encoding` header, CloudFront doesn't compress the object, regardless of the header's value" — but origin-side gzip on SSE will buffer at the *origin*, which is the real cause of most "SSE is buffered" reports. **Disable compression at the origin for `text/event-stream`.**

### Cache policy: `CachingDisabled`

> "**CachingDisabled** — This policy disables caching. This policy is useful for dynamic content and for requests that are not cacheable.
>
> ID: `4135ea2d-6df8-44a3-9df3-4b5a84be39ad`
> + **Minimum TTL:** 0 seconds
> + **Maximum TTL:** 0 seconds
> + **Default TTL:** 0 seconds
> + **Headers included in the cache key:** None
> + **Cookies included in the cache key:** None
> + **Query strings included in the cache key:** None
> + **Cache compressed objects setting:** Disabled"
>
> — https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-cache-policies.html

**Critically, `CachingDisabled` also disables request collapsing** — which would otherwise be catastrophic for SSE (N viewers sharing one stream):
> "When a CloudFront edge location receives a request for an object and the object isn't in the cache… if there are simultaneous requests for the same object… CloudFront pauses before forwarding the additional requests to the origin… CloudFront sends the response from the original request to all the requests that it received while it was paused. This is called *request collapsing*."
>
> "**If you want to prevent all request collapsing, you can use the managed cache policy `CachingDisabled`, which also prevents caching.**"
>
> — https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/RequestAndResponseBehaviorCustomOrigin.html

**Do NOT use `CachingOptimized`** for the API behavior — it has minimum TTL 1 s and the docs warn: "Because this policy has a minimum TTL greater than 0, CloudFront will cache content for at least the duration specified in the cache policy's minimum TTL, **even if the `Cache-Control: no-cache`, `no-store`, or `private` directives are present in the origin headers.**"

`Cache-Control: no-cache` from the origin is respected under a 0-TTL policy: "CloudFront normally respects a `Cache-Control: no-cache` header in the response from the origin. For an exception, see Simultaneous requests for the same object (request collapsing)."

### Origin request policy: `AllViewerExceptHostHeader` — required for a function URL origin

> "**AllViewerExceptHostHeader** — This policy does ***not*** include the `Host` header from the viewer request, but does include all others values (headers, cookies, and query strings) from the viewer request.
>
> **This policy is intended for use with Amazon API Gateway and AWS Lambda function URL origins. These origins expect the `Host` header to contain the origin domain name, not the domain name of the CloudFront distribution. Forwarding the `Host` header from the viewer request to these origins can prevent them from working.**
>
> **Note** — When you use this managed origin request policy to remove the viewer's `Host` header, CloudFront adds a new `Host` header with the origin's domain name to the origin request.
>
> ID: `b689b0a8-53d0-40ab-baf2-68738e2966ac`
> + **Headers included in origin requests:** All headers in the viewer request ***except*** for the `Host` header
> + **Cookies included in origin requests:** All
> + **Query strings included in origin requests:** All"
>
> — https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-origin-request-policies.html

This forwards `Accept` (so `Accept: text/event-stream` reaches your Lambda), all cookies, and all query strings — everything SSE needs. Other IDs on that page for reference: `AllViewer` `216adef6-5c7f-47e4-b989-5492eafa07d3`, `AllViewerAndCloudFrontHeaders-2022-06` `33f36d7e-f396-46d9-90e0-52428a34d9dc`, `CORS-S3Origin` `88a5eaf4-2fd4-4709-b370-b4c650ea3fcf`, `HostHeaderOnly` `bf0718e1-ba1e-49d1-88b1-f726733018ae`.

**Warning:** `AllViewer` (which *does* forward `Host`) will break a Lambda function URL origin. Use `AllViewerExceptHostHeader`.

### Recommended SSE behavior config

| Setting | Value | Why |
|---|---|---|
| Cache policy | `CachingDisabled` (`4135ea2d-…`) | 0 TTL, no cache key dims, **kills request collapsing** |
| Origin request policy | `AllViewerExceptHostHeader` (`b689b0a8-…`) | forwards `Accept`, cookies, query strings; strips `Host` (required for function URL) |
| Compress objects automatically | **Off** | avoids `Accept-Encoding` in cache key; `text/event-stream` isn't compressible anyway |
| Allowed methods | GET/HEAD (+OPTIONS if CORS) | prefer GET so the `x-amz-content-sha256` OAC requirement doesn't apply |
| Origin response timeout | ≥ 30 s (default), or raise toward 120 s | applies **between** SSE packets |
| Origin response completion timeout | **leave unset** | unset ⇒ no maximum ⇒ long streams allowed |
| Origin protocol | HTTPS only | required for function-URL OAC |
| Origin `Cache-Control` | `no-cache` (or `no-store`) | respected under 0-TTL policy |

## C11. The `Authorization` header with a function-URL OAC origin

**Verdict: CONFIRMED — with `signingBehavior: always` (the recommended default) CloudFront OVERWRITES the viewer's `Authorization` header with its own SigV4 signature. The header is destroyed. Use a custom header or cookies for user auth.**

Verbatim, both from the CloudFront docs:

> "+ `always` – CloudFront signs all origin requests, **overwriting the `Authorization` header from the viewer request if one exists.**
> + `never` – CloudFront doesn't sign any origin requests. This value turns off origin access control for the origin.
> + `no-override` – If the viewer request doesn't contain the `Authorization` header, then CloudFront signs the origin request. If the viewer request contains the `Authorization` header, then CloudFront doesn't sign the origin request and instead passes along the `Authorization` header from the viewer request."
>
> — https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/helper-functions-origin-modification.html

> "**Always sign origin requests (recommended setting)** — We recommend using this setting… With this setting, CloudFront always signs all requests that it sends to the Lambda function URL."
>
> "**Don't override the viewer (client) `Authorization` header** — … Use this setting when you want CloudFront to sign origin requests only when the corresponding viewer request does not include an `Authorization` header."
>
> — https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-lambda.html

**Why `no-override` is a trap here** — verbatim from the same page:
> "If you use this setting, **you must specify the Signature Version 4 signing for the Lambda function URL instead of your CloudFront distribution's name or CNAME. When CloudFront forwards the `Authorization` header from the viewer request to the Lambda function URL, Lambda will validate the signature against the host of the Lambda URL domain. If the signature isn't based on the Lambda URL domain, the host in the signature won't match the host used by the Lambda URL origin. This means the request will fail, resulting in a signature validation error.**"
>
> "To pass along the `Authorization` header from the viewer request, you *must* add the `Authorization` header to a **cache policy** for all cache behaviors that use Lambda function URLs associated with this origin access control."

So `no-override` only works if your viewers are themselves SigV4-signing against the Lambda URL domain — useless for a browser app with a JWT.

**Independently, CloudFront strips `Authorization` on GET by default anyway:**
> "`Authorization` | + `GET` and `HEAD` requests – **CloudFront removes the `Authorization` header field before forwarding the request to your origin.** + `OPTIONS` requests – CloudFront removes the `Authorization` header field before forwarding the request to your origin if you configure CloudFront to cache responses to `OPTIONS` requests… + `DELETE`, `PATCH`, `POST`, and `PUT` requests – CloudFront does not remove the header field before forwarding the request to your origin."
>
> — https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/RequestAndResponseBehaviorCustomOrigin.html

Two separate mechanisms (default GET stripping, plus OAC overwrite) both eliminate `Authorization`.

### Recommended ways to carry user auth to the origin

1. **Cookies.** `AllViewerExceptHostHeader` forwards all cookies untouched. This is the cleanest option for browser SSE, since `EventSource` sends cookies for same-origin requests but *cannot* set custom headers at all. **For `EventSource`-based SSE, cookies are effectively your only option.**
2. **A custom header** (e.g. `x-app-authorization`). Forwarded by `AllViewerExceptHostHeader`. Works with `fetch`-based SSE readers, not with `EventSource`.
3. **A CloudFront Function-injected header.** Your viewer-request function already runs; it can validate a token and inject an origin custom header via `cf.updateRequestOrigin({ customHeaders: { "x-pr-id": "123", ... } })`. Note the constraint: "a header with the same name can't also be present in the incoming request `headers`" — so pick a name viewers can't send, and consider stripping any viewer-supplied copy first.
4. **Query string.** Forwarded by `AllViewerExceptHostHeader`, and `EventSource` supports it — but tokens land in logs. Not recommended.

**Recommendation: cookies for `EventSource`; a custom header if you use a `fetch`-based SSE client.** Never rely on `Authorization`.

---

# D. CDK specifics

**Verdict: ALL SIX APIs exist and are stable (non-experimental) in `aws-cdk-lib` 2.268.0.** I installed the package during this session and read the shipped `.d.ts` files directly, so these are not doc-site claims — they are the actual type declarations.

Version confirmed:
```
$ node -p "require('aws-cdk-lib/package.json').version"
2.268.0
```

## D12. Item-by-item confirmation

### 1. `cloudfront.Function` supports `keyValueStore` — YES

`node_modules/aws-cdk-lib/aws-cloudfront/lib/function.d.ts`:
```ts
readonly code: FunctionCode;
/** @default FunctionRuntime.JS_1_0 (unless `keyValueStore` is specified, then `FunctionRuntime.JS_2_0`) */
readonly runtime?: FunctionRuntime;
/**
 * The Key Value Store to associate with this function.
 * In order to associate a Key Value Store, the `runtime` must be
 * cloudfront-js-2.0 or newer.
 * @default - no key value store is associated
 */
readonly keyValueStore?: IKeyValueStoreRef;
/** A flag that determines whether to automatically publish the function to the LIVE stage when it's created.
 *  @default - true */
readonly autoPublish?: boolean;
```
`FunctionRuntime.JS_1_0` and `FunctionRuntime.JS_2_0` (`"cloudfront-js-2.0"`) both exist as static members. Matches https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_cloudfront.Function.html verbatim (quoted in A3 above).

### 2. `cloudfront.KeyValueStore` with `ImportSource.fromInline` / `fromAsset` — YES (and `fromBucket` too)

`node_modules/aws-cdk-lib/aws-cloudfront/lib/key-value-store.d.ts`:
```ts
export declare abstract class ImportSource {
    /** An import source that exists as an object in an S3 bucket.
     *  @param bucket the S3 bucket that contains the data
     *  @param key the key within the S3 bucket that contains the data */
    static fromBucket(bucket: s3.IBucket, key: string): ImportSource;
    /** An import source that exists as a local file.
     *  @param path the path to the local file
     *  @param options the configuration for the temporarily created S3 file */
    static fromAsset(path: string, options?: s3_assets.AssetOptions): ImportSource;
    /** An import source that uses an inline string.
     *  @param data the contents of the KeyValueStore */
    static fromInline(data: string): ImportSource;
}

export interface KeyValueStoreProps {
    /** The unique name of the Key Value Store. @default A generated name */
    readonly keyValueStoreName?: string;
    /** A comment for the Key Value Store @default No comment will be specified */
    readonly comment?: string;
    /** The import source for the Key Value Store.
     *  This will populate the initial items in the Key Value Store. The
     *  source data must be in a valid JSON format.
     *  @default No data will be imported to the store */
    readonly source?: ImportSource;
}

/** @resource AWS::CloudFront::KeyValueStore */
export declare class KeyValueStore extends Resource implements IKeyValueStore { ... }
```
`IKeyValueStore` exposes `keyValueStoreArn`, `keyValueStoreId`, `keyValueStoreStatus`. There's also a static `KeyValueStore.fromKeyValueStoreArn(...)` importer.

**Important caveat for PR previews:** `source` "will populate the **initial** items in the Key Value Store." It is a CloudFormation-managed import, **not** an ongoing sync. Per-PR keys must be written at runtime via the `cloudfront-keyvaluestore` API (B5), not through CDK. If you set `source` and then mutate keys out-of-band, a later `cdk deploy` that changes the import source could clobber your runtime writes. **Recommendation: create the `KeyValueStore` with no `source` (or a trivially small bootstrap) and manage all PR keys via the API.**

### 3. `origins.FunctionUrlOrigin.withOriginAccessControl(...)` — YES

`node_modules/aws-cdk-lib/aws-cloudfront-origins/lib/function-url-origin.d.ts`:
```ts
export interface FunctionUrlOriginWithOACProps extends FunctionUrlOriginProps {
    readonly originAccessControl?: cloudfront.IOriginAccessControlRef;
}
export declare class FunctionUrlOrigin extends cloudfront.OriginBase {
    static withOriginAccessControl(
        lambdaFunctionUrl: lambda.IFunctionUrl,
        props?: FunctionUrlOriginWithOACProps
    ): cloudfront.IOrigin;
}
```
`originAccessControl` is optional — CDK creates one for you if omitted.

### 4. `origins.S3BucketOrigin.withOriginAccessControl` — YES

`node_modules/aws-cdk-lib/aws-cloudfront-origins/lib/s3-bucket-origin.d.ts`:
```ts
export declare abstract class S3BucketOrigin extends cloudfront.OriginBase {
    static withOriginAccessControl(bucket: IBucket, props?: S3BucketOriginWithOACProps): cloudfront.IOrigin;
    /** OAI is a legacy feature and we **strongly** recommend you to use OAC via `withOriginAccessControl()` */
    static withOriginAccessIdentity(bucket: IBucket, props?: S3BucketOriginWithOAIProps): cloudfront.IOrigin;
    static withBucketDefaults(bucket: IBucket, props?: cloudfront.OriginProps): cloudfront.IOrigin;
}
```

### 5. `cloudfront.Distribution` `additionalBehaviors` — YES

`node_modules/aws-cdk-lib/aws-cloudfront/lib/distribution.d.ts`:
```ts
/** The default behavior for the distribution. */
readonly defaultBehavior: BehaviorOptions;
/** Additional behaviors for the distribution, mapped by the pathPattern that specifies which requests to apply the behavior to.
 *  @default - no additional behaviors are added. */
readonly additionalBehaviors?: Record<string, BehaviorOptions>;
```
Keyed by **path pattern**, not host. Remember from A2 that a CloudFront Function cannot steer behavior selection — behavior is chosen from the original viewer URI before the function runs. And `Cache behaviors per distribution` is 75 by default, so do **not** create a behavior per PR.

### 6. `lambda.FunctionUrl` with `invokeMode: RESPONSE_STREAM` — YES

`node_modules/aws-cdk-lib/aws-lambda/lib/function-url.d.ts`:
```ts
export declare enum InvokeMode {
    BUFFERED = "BUFFERED",
    RESPONSE_STREAM = "RESPONSE_STREAM"
}
...
/** @default InvokeMode.BUFFERED */
readonly invokeMode?: InvokeMode;
```

### Sketch (types verified against 2.268.0; not compiled)

```ts
const kvs = new cloudfront.KeyValueStore(this, 'PreviewRoutes', {
  keyValueStoreName: 'pr-preview-routes',
  // no `source` — PR keys are written at runtime via cloudfront-keyvaluestore API
});

const router = new cloudfront.Function(this, 'Router', {
  code: cloudfront.FunctionCode.fromFile({ filePath: 'fn/router.js' }),
  keyValueStore: kvs,            // CDK auto-selects FunctionRuntime.JS_2_0
});

const url = fn.addFunctionUrl({
  authType: lambda.FunctionUrlAuthType.AWS_IAM,   // required for OAC
  invokeMode: lambda.InvokeMode.RESPONSE_STREAM,  // required for SSE
});

new cloudfront.Distribution(this, 'Dist', {
  defaultBehavior: {
    origin: origins.S3BucketOrigin.withOriginAccessControl(staticBucket),
    functionAssociations: [{ function: router, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
  },
  additionalBehaviors: {
    '/api/*': {
      origin: origins.FunctionUrlOrigin.withOriginAccessControl(url),
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      compress: false,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      functionAssociations: [{ function: router, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
    },
  },
});
```

**Two things CDK will NOT do for you:**
1. Grant `lambda:InvokeFunctionUrl` + `lambda:InvokeFunction` to `cloudfront.amazonaws.com` with the distribution `SourceArn` **for each PR's Lambda** — the L2 wires this for the origin it knows about at synth time, not for the per-PR functions your CloudFront Function targets dynamically at runtime. You must add these permissions at PR-deploy time (see C8).
2. Write per-PR KVS keys. That's the runtime `cloudfront-keyvaluestore` API (B5).

---

# Summary of open questions / doc conflicts

| # | Issue |
|---|---|
| 1 | **CloudFront Functions max execution time is not published** as an absolute number — only "compute utilization" 0–100. Monitor the `ComputeUtilization` metric. |
| 2 | **OAC bucket-policy requirement when `updateRequestOrigin` targets an arbitrary S3 bucket is undocumented.** The `originAccessControlConfig` description calls itself "the unique identifier of an OAC" but exposes no ID field. Test before committing. |
| 3 | **KVS ETag-mismatch error code is inferred, not stated.** `ConflictException`/409 fits, `ValidationException`/400 is possible. Handle both. |
| 4 | **KVS write API rate limits are not published** in either the CloudFront quota page or the AWS General Reference. No `ThrottlingException` in the documented error list either. Implement backoff anyway. |
| 5 | **Max number of keys per KVS is not documented.** Only the 5 MB store cap, 512 B keys, 1 KB values. |
| 6 | **KVS key length conflict:** API reference says `Key` max length 1024; quota page says 512 bytes. Treat 512 as operative. |
| 7 | **Keep-alive timeout max conflict:** Developer Guide quota page says 1–300 s; AWS General Reference says 120 s. Verify in Service Quotas. |
| 8 | **Request length conflict:** Developer Guide says 32,768 bytes; General Reference says 20,480 bytes. |
| 9 | **KVS propagation "a few seconds"** is a 2023 blog claim with no Developer Guide statement and no SLA. Poll/retry after CI writes. |
| 10 | **Lambda "20 MB soft limit" is obsolete** (now 200 MB) but still appears in the 2023 launch blog. |
| 11 | The April-2026 "response streaming in all commercial Regions" announcement URL surfaced in search but I did **not** fetch its body. Verify Region availability for your target Region. |
| 12 | The widely-repeated claim "CloudFront buffers SSE" is **contradicted** by the official chunked-transfer docs. The real causes are origin-side gzip and the 30 s read timeout. |
