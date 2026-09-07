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
 * `RequestType`.
 *
 * [Epoch 4] A second `ResourceType`, `PoolUser`, lives here too: the preview
 * pool's machine user (plan.md D6). It is the same shape of problem — an API
 * CloudFormation has no resource type for — and `applyPoolUser` is written
 * against the `PoolUserDirectory` interface for the same reason. One bundle
 * serves both because `PreviewSite` and `PreviewDeployment` would otherwise
 * ship two nearly identical Lambdas. An unknown `ResourceType` throws.
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

/**
 * The Cognito admin calls the machine user needs, and the one Secrets Manager
 * read that feeds them. Named apart from the SDK so `applyPoolUser` can be
 * tested against a fake.
 */
export interface PoolUserDirectory {
  createUser(input: { userPoolId: string; username: string; email: string }): Promise<void>
  setPassword(input: {
    userPoolId: string
    username: string
    password: string
  }): Promise<void>
  deleteUser(input: { userPoolId: string; username: string }): Promise<void>
  readPassword(input: { secretArn: string; passwordKey: string }): Promise<string>
}

export interface PoolUserRequest {
  readonly operation: 'upsert' | 'delete'
  readonly userPoolId: string
  readonly username: string
  readonly email?: string
  readonly secretArn?: string
  readonly passwordKey?: string
}

function isAlreadyExists(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === 'UsernameExistsException'
}

function isGone(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name
  return name === 'UserNotFoundException' || name === 'ResourceNotFoundException'
}

/**
 * Creates (or repairs) the machine user and gives it a permanent password.
 *
 * `AdminCreateUser` is the only way in: the pool has self-sign-up off, and it
 * runs with `MessageAction: SUPPRESS` so Cognito never emails the address —
 * which is not a real mailbox. The freshly created user is in
 * `FORCE_CHANGE_PASSWORD`, and `AdminSetUserPassword --permanent` is what
 * moves it to `CONFIRMED` so `USER_PASSWORD_AUTH` returns tokens instead of a
 * challenge. An existing user is not an error — a stack update re-runs this,
 * and re-setting the password is how a rotated secret takes effect.
 *
 * The password is read here, at runtime, from Secrets Manager: it must never
 * reach the CloudFormation template, a change set, or a stack event.
 */
export async function applyPoolUser(
  directory: PoolUserDirectory,
  request: PoolUserRequest,
): Promise<string> {
  const id = `pooluser:${request.userPoolId}#${request.username}`

  if (request.operation === 'delete') {
    try {
      await directory.deleteUser({
        userPoolId: request.userPoolId,
        username: request.username,
      })
    } catch (error) {
      // A user, or a whole pool, that is already gone is a successful delete.
      // A stack delete must never wedge on cleanup.
      if (!isGone(error)) throw error
    }
    return id
  }

  if (!request.secretArn || !request.passwordKey) {
    throw new Error('PoolUser: SecretArn and PasswordKey are required to create a user')
  }

  try {
    await directory.createUser({
      userPoolId: request.userPoolId,
      username: request.username,
      email: request.email ?? '',
    })
  } catch (error) {
    if (!isAlreadyExists(error)) throw error
  }

  const password = await directory.readPassword({
    secretArn: request.secretArn,
    passwordKey: request.passwordKey,
  })
  await directory.setPassword({
    userPoolId: request.userPoolId,
    username: request.username,
    password,
  })

  return id
}

interface KvsRouteResourceProperties {
  readonly ResourceType: 'KvsRoute'
  readonly KvsArn: string
  readonly Key: string
  readonly Value: string
}

interface PoolUserResourceProperties {
  readonly ResourceType: 'PoolUser'
  readonly UserPoolId: string
  readonly Username: string
  readonly Email: string
  readonly SecretArn: string
  readonly PasswordKey: string
}

type ResourceProperties = KvsRouteResourceProperties | PoolUserResourceProperties

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

async function createPoolUserDirectory(): Promise<PoolUserDirectory> {
  // Lazy, like `createKvsStore`: the pure half of this module is what the unit
  // tests exercise, and it must not drag the AWS SDK into a vitest run.
  const {
    CognitoIdentityProviderClient,
    AdminCreateUserCommand,
    AdminSetUserPasswordCommand,
    AdminDeleteUserCommand,
  } = await import('@aws-sdk/client-cognito-identity-provider')
  const { SecretsManagerClient, GetSecretValueCommand } = await import(
    '@aws-sdk/client-secrets-manager'
  )

  const cognito = new CognitoIdentityProviderClient({ region: 'us-east-1' })
  const secrets = new SecretsManagerClient({ region: 'us-east-1' })

  return {
    async createUser({ userPoolId, username, email }) {
      await cognito.send(
        new AdminCreateUserCommand({
          UserPoolId: userPoolId,
          Username: username,
          // The address is not a mailbox; SUPPRESS is what keeps Cognito from
          // trying to send an invitation to it.
          MessageAction: 'SUPPRESS',
          UserAttributes: [
            { Name: 'email', Value: email },
            { Name: 'email_verified', Value: 'true' },
          ],
        }),
      )
    },
    async setPassword({ userPoolId, username, password }) {
      await cognito.send(
        new AdminSetUserPasswordCommand({
          UserPoolId: userPoolId,
          Username: username,
          Password: password,
          Permanent: true,
        }),
      )
    },
    async deleteUser({ userPoolId, username }) {
      await cognito.send(
        new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: username }),
      )
    },
    async readPassword({ secretArn, passwordKey }) {
      const response = await secrets.send(
        new GetSecretValueCommand({ SecretId: secretArn }),
      )
      if (!response.SecretString) {
        throw new Error(`secret ${secretArn} has no SecretString`)
      }
      const parsed = JSON.parse(response.SecretString) as Record<string, unknown>
      const password = parsed[passwordKey]
      if (typeof password !== 'string' || !password) {
        throw new Error(`secret ${secretArn} has no string field ${passwordKey}`)
      }
      return password
    },
  }
}

export const handler = async (
  event: CdkCustomResourceEvent<ResourceProperties>,
): Promise<CdkCustomResourceResponse> => {
  const properties = event.ResourceProperties

  if (properties.ResourceType === 'PoolUser') {
    const directory = await createPoolUserDirectory()
    const PhysicalResourceId = await applyPoolUser(directory, {
      operation: event.RequestType === 'Delete' ? 'delete' : 'upsert',
      userPoolId: properties.UserPoolId,
      username: properties.Username,
      email: properties.Email,
      secretArn: properties.SecretArn,
      passwordKey: properties.PasswordKey,
    })
    return { PhysicalResourceId }
  }

  if (properties.ResourceType !== 'KvsRoute') {
    throw new Error(`unknown ResourceType: ${String((properties as { ResourceType: unknown }).ResourceType)}`)
  }

  const { KvsArn, Key, Value } = properties
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
