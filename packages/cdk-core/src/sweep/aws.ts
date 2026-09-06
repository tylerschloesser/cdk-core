/**
 * `createSweepDeps` — the real `SweepDeps` (plan.md D3) behind `cdk-core
 * sweep`. `reconcile.ts` knows nothing about the AWS SDK or `gh`; this file
 * is the only place that does, so it is never exercised by
 * `test/sweep.test.ts` directly.
 */

// The CloudFront KeyValueStore data-plane endpoint is global, so its client
// signs with **SigV4A**, and the AWS SDK ships no SigV4A implementation by
// default — it looks one up in a registry that a separate package populates
// on import. Bundled, that lookup finds nothing and every KVS call fails at
// `describe` with "Neither CRT nor JS SigV4a implementation is available",
// taking the sweep down with it. This side-effect import is what registers
// the pure-JS implementation; the package declares `sideEffects: true`, so
// esbuild keeps it. Same hazard, same fix, as `src/handlers/preview-resources.ts`
// (`.claude/rules/cdk.md` § KeyValueStore writes).
import '@aws-sdk/signature-v4a'

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { SweepDeps } from './reconcile.js'

const execFileAsync = promisify(execFile)

export interface CreateSweepDepsOptions {
  readonly site: string
  readonly stackPrefix: string
  readonly repo: string
  readonly region: string
}

// Copied from the non-deleted status list in
// /Users/tyler/repos/yahn.ty.ler.dev/.github/workflows/cleanup.yml.
const NON_DELETED_STACK_STATUSES = [
  'CREATE_COMPLETE',
  'UPDATE_COMPLETE',
  'UPDATE_ROLLBACK_COMPLETE',
  'ROLLBACK_COMPLETE',
  'CREATE_FAILED',
  'UPDATE_FAILED',
  'DELETE_FAILED',
] as const

function isRetryableKvsError(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name
  return name === 'ConflictException' || name === 'ValidationException'
}

function isNotFoundKvsError(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name
  return name === 'ResourceNotFoundException'
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

export function createSweepDeps(options: CreateSweepDepsOptions): SweepDeps {
  // `stackPrefix` is accepted for symmetry with `SweepOptions` (and because
  // the CLI has the flag in hand) but is not used below: `ListStacksCommand`
  // has no server-side name filter, so `listPreviewStacks` returns every
  // non-deleted stack and `reconcile.ts` applies the anchored prefix match.
  const { site, repo, region } = options

  // Lazily constructed so a missing SSM parameter only breaks the KVS/S3
  // methods, not stack listing/deletion or PR lookups.
  let paramsPromise: Promise<{ kvsArn: string; bucketName: string }> | undefined
  async function resolveParams(): Promise<{ kvsArn: string; bucketName: string }> {
    if (!paramsPromise) {
      paramsPromise = (async () => {
        const { SSMClient, GetParameterCommand } = await import('@aws-sdk/client-ssm')
        const ssm = new SSMClient({ region })
        const [kvsArn, bucketName] = await Promise.all([
          ssm
            .send(new GetParameterCommand({ Name: `/cdk-core/${site}/preview/kvsArn` }))
            .then((r) => r.Parameter?.Value),
          ssm
            .send(new GetParameterCommand({ Name: `/cdk-core/${site}/preview/bucketName` }))
            .then((r) => r.Parameter?.Value),
        ])
        if (!kvsArn) {
          throw new Error(`SSM parameter /cdk-core/${site}/preview/kvsArn has no value`)
        }
        if (!bucketName) {
          throw new Error(`SSM parameter /cdk-core/${site}/preview/bucketName has no value`)
        }
        return { kvsArn, bucketName }
      })()
    }
    return paramsPromise
  }

  return {
    async listPreviewStacks() {
      const { CloudFormationClient, ListStacksCommand } = await import(
        '@aws-sdk/client-cloudformation'
      )
      const cfn = new CloudFormationClient({ region })
      const names: string[] = []
      let nextToken: string | undefined
      do {
        const response = await cfn.send(
          new ListStacksCommand({
            StackStatusFilter: [...NON_DELETED_STACK_STATUSES],
            NextToken: nextToken,
          }),
        )
        for (const summary of response.StackSummaries ?? []) {
          if (summary.StackName) {
            names.push(summary.StackName)
          }
        }
        nextToken = response.NextToken
      } while (nextToken)
      return names
    },

    async deleteStack(name) {
      const {
        CloudFormationClient,
        DeleteStackCommand,
        waitUntilStackDeleteComplete,
      } = await import('@aws-sdk/client-cloudformation')
      const cfn = new CloudFormationClient({ region })
      await cfn.send(new DeleteStackCommand({ StackName: name }))
      await waitUntilStackDeleteComplete(
        { client: cfn, maxWaitTime: 900 },
        { StackName: name },
      )
    },

    async listKvsKeys() {
      const { CloudFrontKeyValueStoreClient, ListKeysCommand } = await import(
        '@aws-sdk/client-cloudfront-keyvaluestore'
      )
      const { kvsArn } = await resolveParams()
      const client = new CloudFrontKeyValueStoreClient({ region })
      const keys: string[] = []
      let nextToken: string | undefined
      do {
        const response = await client.send(
          new ListKeysCommand({ KvsARN: kvsArn, MaxResults: 50, NextToken: nextToken }),
        )
        for (const item of response.Items ?? []) {
          if (item.Key) {
            keys.push(item.Key)
          }
        }
        nextToken = response.NextToken
      } while (nextToken)
      return keys
    },

    async deleteKvsKey(key) {
      const {
        CloudFrontKeyValueStoreClient,
        DescribeKeyValueStoreCommand,
        DeleteKeyCommand,
      } = await import('@aws-sdk/client-cloudfront-keyvaluestore')
      const { kvsArn } = await resolveParams()
      const client = new CloudFrontKeyValueStoreClient({ region })

      // Same describe-then-write-retried-as-a-unit discipline as
      // `applyKvsRoute` in src/handlers/preview-resources.ts: the ETag
      // versions the whole store, so every attempt re-describes.
      const maxAttempts = 10
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const described = await client.send(
            new DescribeKeyValueStoreCommand({ KvsARN: kvsArn }),
          )
          if (!described.ETag) {
            throw new Error(`DescribeKeyValueStore returned no ETag for ${kvsArn}`)
          }
          await client.send(
            new DeleteKeyCommand({ KvsARN: kvsArn, Key: key, IfMatch: described.ETag }),
          )
          return
        } catch (error) {
          if (isNotFoundKvsError(error)) {
            // Deleting a key or a store that is already gone is success —
            // a sweep must never wedge on cleanup.
            return
          }
          if (!isRetryableKvsError(error) || attempt === maxAttempts) {
            throw error
          }
          await sleep(100 + Math.random() * 400)
        }
      }
    },

    async listAssetPrefixes() {
      const { S3Client, ListObjectsV2Command } = await import('@aws-sdk/client-s3')
      const { bucketName } = await resolveParams()
      const s3 = new S3Client({ region })
      const prefixes: string[] = []
      let continuationToken: string | undefined
      do {
        const response = await s3.send(
          new ListObjectsV2Command({
            Bucket: bucketName,
            Delimiter: '/',
            ContinuationToken: continuationToken,
          }),
        )
        for (const common of response.CommonPrefixes ?? []) {
          if (common.Prefix) {
            prefixes.push(common.Prefix)
          }
        }
        continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined
      } while (continuationToken)
      return prefixes
    },

    async deleteAssetPrefix(prefix) {
      const { S3Client, ListObjectsV2Command, DeleteObjectsCommand } = await import(
        '@aws-sdk/client-s3'
      )
      const { bucketName } = await resolveParams()
      const s3 = new S3Client({ region })

      const keys: string[] = []
      let continuationToken: string | undefined
      do {
        const response = await s3.send(
          new ListObjectsV2Command({
            Bucket: bucketName,
            Prefix: prefix,
            ContinuationToken: continuationToken,
          }),
        )
        for (const object of response.Contents ?? []) {
          if (object.Key) {
            keys.push(object.Key)
          }
        }
        continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined
      } while (continuationToken)

      for (let i = 0; i < keys.length; i += 1000) {
        const batch = keys.slice(i, i + 1000)
        if (batch.length === 0) {
          continue
        }
        await s3.send(
          new DeleteObjectsCommand({
            Bucket: bucketName,
            Delete: { Objects: batch.map((Key) => ({ Key })) },
          }),
        )
      }
    },

    async prState(n) {
      const { stdout } = await execFileAsync('gh', [
        'pr',
        'view',
        String(n),
        '--repo',
        repo,
        '--json',
        'state',
        '--jq',
        '.state',
      ])
      const state = stdout.trim()
      if (state !== 'OPEN' && state !== 'CLOSED' && state !== 'MERGED') {
        throw new Error(`gh pr view ${n} returned unexpected state: ${state || '(empty)'}`)
      }
      return state
    },

    log(line) {
      console.log(line)
    },
  }
}
