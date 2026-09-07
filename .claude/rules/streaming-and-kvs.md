---
paths:
  - "packages/cdk-core/src/handlers/**"
  - "packages/cdk-core/src/sse.ts"
  - "packages/cdk-core/src/sweep/aws.ts"
  - "apps/api/src/events.ts"
  - "apps/api/src/lambda-events.ts"
---

# Streaming, and writing to the KeyValueStore

Loaded when you touch the SSE producer or parser, a bundled handler, or anything that writes
to the KVS. The distribution and router side is `.claude/rules/cdk.md`.

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
- **Propagation to the edge is asymmetric, and the create side is slow.** A *new* preview
  hostname takes a median of **29.0 s** to start resolving at one PoP (range 14.3-29.4, 7
  samples); a hostname that PoP has already seen re-propagates in ~1.4 s, so the cost tracks
  the novelty of the key, not the write. Deleting is ~**46 ms** at the same PoP (median of 7,
  range 42-47). None of that contradicts the ~1 minute a *teardown* takes to look gone from
  outside: that is the last edge to catch up, this is the nearest one. `pr-preview.yml` polls
  for 5 minutes, so ~10x headroom — do not shorten it on the strength of one fast sample.
- Calling the KVS API needs SigV4A for the other reason too: a CI runner using the *global*
  STS endpoint gets a v1 token that fails. That is why the writer is a Lambda-backed custom
  resource and not a step in a workflow.
