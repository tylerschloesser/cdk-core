/**
 * The CloudFormation custom-resource Lambda behind `KvsRoute` (plan.md D2):
 * every PR stack that wants a preview hostname routed writes one key into the
 * site's shared CloudFront KeyValueStore. The ETag versions the *whole*
 * store, so two PR stacks deploying at once race even on different keys —
 * `applyKvsRoute` is the retry loop that makes that race survivable.
 *
 * `applyKvsRoute` itself knows nothing about Lambda, CloudFormation, or the
 * AWS SDK — it is exercised in tests against the `KvsStore` interface below.
 * `handler` is the thin wrapper that builds a real store and dispatches on
 * `RequestType`. Epoch 4 adds a second `ResourceType` (`PoolUser`); an
 * unknown one throws.
 */

import type {
  CdkCustomResourceEvent,
  CdkCustomResourceResponse,
} from 'aws-lambda'

// The CloudFront KeyValueStore data-plane endpoint is global, so its client
// signs with **SigV4A**, and the AWS SDK ships no SigV4A implementation by
// default — it looks one up in a registry that a separate package populates on
// import. Bundled, that lookup finds nothing and every call fails at
// `describe` with "Neither CRT nor JS SigV4a implementation is available".
// This side-effect import is what registers the pure-JS implementation; the
// package declares `sideEffects: true`, so esbuild keeps it. It is not
// optional and it is not unused — deleting it breaks every preview deploy.
// (plan.md D2 flagged the SigV4A hazard; this is the concrete form it takes.)
import '@aws-sdk/signature-v4a'

export interface KvsStore {
  describe(kvsArn: string): Promise<{ etag: string }>
  updateKeys(input: {
    kvsArn: string
    ifMatch: string
    puts?: { key: string; value: string }[]
    deletes?: { key: string }[]
  }): Promise<void>
}

export interface KvsRouteRequest {
  readonly operation: 'put' | 'delete'
  readonly kvsArn: string
  readonly key: string
  readonly value?: string
}

export interface ApplyKvsRouteOptions {
  readonly sleep?: (ms: number) => Promise<void>
  readonly random?: () => number
  readonly maxAttempts?: number
}

function physicalResourceId(kvsArn: string, key: string): string {
  return `kvsroute:${kvsArn}#${key}`
}

function isRetryable(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name
  return name === 'ConflictException' || name === 'ValidationException'
}

function isNotFound(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name
  return name === 'ResourceNotFoundException'
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Describe-then-write, retried as a single unit up to `maxAttempts` times
 * whenever the write fails with `ConflictException` or `ValidationException`
 * (the exact ETag-mismatch code is undocumented — plan.md D2 — so both are
 * treated as retryable). Every attempt re-describes: a stale ETag is the
 * whole point of retrying.
 *
 * A delete against a key or a store that is already gone is treated as
 * success, so a stack delete never wedges on it.
 */
export async function applyKvsRoute(
  store: KvsStore,
  request: KvsRouteRequest,
  options: ApplyKvsRouteOptions = {},
): Promise<string> {
  const sleep = options.sleep ?? defaultSleep
  const random = options.random ?? Math.random
  const maxAttempts = options.maxAttempts ?? 10

  const id = physicalResourceId(request.kvsArn, request.key)

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { etag } = await store.describe(request.kvsArn)
      if (request.operation === 'put') {
        await store.updateKeys({
          kvsArn: request.kvsArn,
          ifMatch: etag,
          puts: [{ key: request.key, value: request.value ?? '' }],
        })
      } else {
        await store.updateKeys({
          kvsArn: request.kvsArn,
          ifMatch: etag,
          deletes: [{ key: request.key }],
        })
      }
      return id
    } catch (error) {
      if (request.operation === 'delete' && isNotFound(error)) {
        return id
      }
      if (!isRetryable(error) || attempt === maxAttempts) {
        throw error
      }
      const ms = 100 + random() * 400
      await sleep(ms)
    }
  }

  // Unreachable: the loop always returns or throws.
  throw new Error('applyKvsRoute: exhausted attempts without resolving')
}

interface KvsRouteResourceProperties {
  readonly ResourceType: 'KvsRoute'
  readonly KvsArn: string
  readonly Key: string
  readonly Value: string
}

type ResourceProperties = KvsRouteResourceProperties

async function createKvsStore(): Promise<KvsStore> {
  // Imported lazily so `applyKvsRoute` — the piece the unit tests exercise —
  // does not pull the AWS SDK into module scope for a vitest run.
  const {
    CloudFrontKeyValueStoreClient,
    DescribeKeyValueStoreCommand,
    UpdateKeysCommand,
  } = await import('@aws-sdk/client-cloudfront-keyvaluestore')

  const client = new CloudFrontKeyValueStoreClient({ region: 'us-east-1' })

  return {
    async describe(kvsArn) {
      const response = await client.send(
        new DescribeKeyValueStoreCommand({ KvsARN: kvsArn }),
      )
      if (!response.ETag) {
        throw new Error(`DescribeKeyValueStore returned no ETag for ${kvsArn}`)
      }
      return { etag: response.ETag }
    },
    async updateKeys(input) {
      await client.send(
        new UpdateKeysCommand({
          KvsARN: input.kvsArn,
          IfMatch: input.ifMatch,
          Puts: input.puts?.map((p) => ({ Key: p.key, Value: p.value })),
          Deletes: input.deletes?.map((d) => ({ Key: d.key })),
        }),
      )
    },
  }
}

export const handler = async (
  event: CdkCustomResourceEvent<ResourceProperties>,
): Promise<CdkCustomResourceResponse> => {
  const { ResourceType, KvsArn, Key, Value } = event.ResourceProperties

  if (ResourceType !== 'KvsRoute') {
    throw new Error(`unknown ResourceType: ${String(ResourceType)}`)
  }

  const store = await createKvsStore()

  if (event.RequestType === 'Delete') {
    const PhysicalResourceId = await applyKvsRoute(store, {
      operation: 'delete',
      kvsArn: KvsArn,
      key: Key,
    })
    return { PhysicalResourceId }
  }

  const PhysicalResourceId = await applyKvsRoute(store, {
    operation: 'put',
    kvsArn: KvsArn,
    key: Key,
    value: Value,
  })
  return { PhysicalResourceId }
}
