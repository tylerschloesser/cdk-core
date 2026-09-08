import { describe, expect, it, vi } from 'vitest'
import {
  applyKvsRoute,
  applyKvsSecret,
  applyPoolUser,
  handler,
  readSecretField,
} from '../src/handlers/preview-resources.js'
import type {
  KvsStore,
  PoolUserDirectory,
  SecretReader,
} from '../src/handlers/preview-resources.js'

const KVS_ARN = 'arn:aws:cloudfront::063257577013:key-value-store/test'

function fakeStore(overrides: Partial<KvsStore> = {}): KvsStore {
  return {
    describe: vi.fn(async () => ({ etag: 'etag-0' })),
    updateKeys: vi.fn(async () => undefined),
    ...overrides,
  }
}

function conflictError(): Error {
  const error = new Error('conflict')
  error.name = 'ConflictException'
  return error
}

function validationError(): Error {
  const error = new Error('validation')
  error.name = 'ValidationException'
  return error
}

function notFoundError(): Error {
  const error = new Error('not found')
  error.name = 'ResourceNotFoundException'
  return error
}

function accessDeniedError(): Error {
  const error = new Error('denied')
  error.name = 'AccessDeniedException'
  return error
}

// A no-op sleep so retry tests do not actually wait 100-500ms per attempt.
const noSleep = async () => undefined

describe('applyKvsRoute', () => {
  it('writes the key on Create, using the ETag from describe', async () => {
    const describe = vi.fn(async () => ({ etag: 'etag-abc' }))
    const updateKeys = vi.fn(async () => undefined)
    const store = fakeStore({ describe, updateKeys })

    const id = await applyKvsRoute(
      store,
      { operation: 'put', kvsArn: KVS_ARN, key: 'pr-1.preview.example.com', value: '{"a":1}' },
      { sleep: noSleep },
    )

    expect(describe).toHaveBeenCalledWith(KVS_ARN)
    expect(updateKeys).toHaveBeenCalledWith({
      kvsArn: KVS_ARN,
      ifMatch: 'etag-abc',
      puts: [{ key: 'pr-1.preview.example.com', value: '{"a":1}' }],
    })
    expect(id).toBe(`kvsroute:${KVS_ARN}#pr-1.preview.example.com`)
  })

  it('deletes the key on Delete', async () => {
    const describe = vi.fn(async () => ({ etag: 'etag-abc' }))
    const updateKeys = vi.fn(async () => undefined)
    const store = fakeStore({ describe, updateKeys })

    const id = await applyKvsRoute(
      store,
      { operation: 'delete', kvsArn: KVS_ARN, key: 'pr-1.preview.example.com' },
      { sleep: noSleep },
    )

    expect(updateKeys).toHaveBeenCalledWith({
      kvsArn: KVS_ARN,
      ifMatch: 'etag-abc',
      deletes: [{ key: 'pr-1.preview.example.com' }],
    })
    expect(id).toBe(`kvsroute:${KVS_ARN}#pr-1.preview.example.com`)
  })

  it('retries ConflictException twice then succeeds, re-describing (a fresh ETag) each attempt', async () => {
    let call = 0
    const describe = vi.fn(async () => {
      call += 1
      return { etag: `etag-${call}` }
    })
    const updateKeys = vi
      .fn()
      .mockRejectedValueOnce(conflictError())
      .mockRejectedValueOnce(conflictError())
      .mockResolvedValueOnce(undefined)
    const store = fakeStore({ describe, updateKeys })

    const id = await applyKvsRoute(
      store,
      { operation: 'put', kvsArn: KVS_ARN, key: 'k', value: 'v' },
      { sleep: noSleep },
    )

    expect(id).toBe(`kvsroute:${KVS_ARN}#k`)
    expect(describe).toHaveBeenCalledTimes(3)
    expect(updateKeys).toHaveBeenCalledTimes(3)
    expect(updateKeys).toHaveBeenNthCalledWith(1, expect.objectContaining({ ifMatch: 'etag-1' }))
    expect(updateKeys).toHaveBeenNthCalledWith(2, expect.objectContaining({ ifMatch: 'etag-2' }))
    expect(updateKeys).toHaveBeenNthCalledWith(3, expect.objectContaining({ ifMatch: 'etag-3' }))
  })

  it('retries ValidationException the same way', async () => {
    const describe = vi.fn(async () => ({ etag: 'etag-x' }))
    const updateKeys = vi
      .fn()
      .mockRejectedValueOnce(validationError())
      .mockRejectedValueOnce(validationError())
      .mockResolvedValueOnce(undefined)
    const store = fakeStore({ describe, updateKeys })

    await applyKvsRoute(
      store,
      { operation: 'put', kvsArn: KVS_ARN, key: 'k', value: 'v' },
      { sleep: noSleep },
    )

    expect(describe).toHaveBeenCalledTimes(3)
    expect(updateKeys).toHaveBeenCalledTimes(3)
  })

  it('propagates a non-retryable error after exactly one attempt', async () => {
    const describe = vi.fn(async () => ({ etag: 'etag-x' }))
    const updateKeys = vi.fn().mockRejectedValueOnce(accessDeniedError())
    const store = fakeStore({ describe, updateKeys })

    await expect(
      applyKvsRoute(
        store,
        { operation: 'put', kvsArn: KVS_ARN, key: 'k', value: 'v' },
        { sleep: noSleep },
      ),
    ).rejects.toMatchObject({ name: 'AccessDeniedException' })

    expect(describe).toHaveBeenCalledTimes(1)
    expect(updateKeys).toHaveBeenCalledTimes(1)
  })

  it('rejects after 10 consecutive ConflictExceptions, calling updateKeys exactly 10 times', async () => {
    const describe = vi.fn(async () => ({ etag: 'etag-x' }))
    const updateKeys = vi.fn(async () => {
      throw conflictError()
    })
    const store = fakeStore({ describe, updateKeys })

    await expect(
      applyKvsRoute(
        store,
        { operation: 'put', kvsArn: KVS_ARN, key: 'k', value: 'v' },
        { sleep: noSleep },
      ),
    ).rejects.toMatchObject({ name: 'ConflictException' })

    expect(updateKeys).toHaveBeenCalledTimes(10)
  })

  it('treats a delete against a missing key/store (ResourceNotFoundException) as success', async () => {
    const describe = vi.fn(async () => ({ etag: 'etag-x' }))
    const updateKeys = vi.fn().mockRejectedValueOnce(notFoundError())
    const store = fakeStore({ describe, updateKeys })

    const id = await applyKvsRoute(
      store,
      { operation: 'delete', kvsArn: KVS_ARN, key: 'k' },
      { sleep: noSleep },
    )

    expect(id).toBe(`kvsroute:${KVS_ARN}#k`)
    expect(updateKeys).toHaveBeenCalledTimes(1)
  })

  it('sleeps between attempts with a value in [100, 500), driven by the injected random source', async () => {
    const describe = vi.fn(async () => ({ etag: 'etag-x' }))
    const updateKeys = vi
      .fn()
      .mockRejectedValueOnce(conflictError())
      .mockResolvedValueOnce(undefined)
    const store = fakeStore({ describe, updateKeys })
    const sleep = vi.fn(async (_ms: number) => undefined)

    await applyKvsRoute(
      store,
      { operation: 'put', kvsArn: KVS_ARN, key: 'k', value: 'v' },
      { sleep, random: () => 0 },
    )
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(sleep.mock.calls[0]?.[0]).toBe(100)

    const store2 = fakeStore({
      describe,
      updateKeys: vi
        .fn()
        .mockRejectedValueOnce(conflictError())
        .mockResolvedValueOnce(undefined),
    })
    const sleep2 = vi.fn(async (_ms: number) => undefined)
    await applyKvsRoute(
      store2,
      { operation: 'put', kvsArn: KVS_ARN, key: 'k', value: 'v' },
      { sleep: sleep2, random: () => 0.999999 },
    )
    const ms = sleep2.mock.calls[0]?.[0]
    expect(ms).toBeGreaterThanOrEqual(100)
    expect(ms).toBeLessThan(500)
  })

  it('logs nothing on a first-attempt success', async () => {
    const store = fakeStore()
    const log = vi.fn()

    await applyKvsRoute(
      store,
      { operation: 'put', kvsArn: KVS_ARN, key: 'k', value: 'v' },
      { sleep: noSleep, log },
    )

    expect(log).not.toHaveBeenCalled()
  })

  it('logs exactly two lines for a write that fails once with ValidationException then succeeds', async () => {
    const describe = vi.fn(async () => ({ etag: 'etag-x' }))
    const updateKeys = vi
      .fn()
      .mockRejectedValueOnce(validationError())
      .mockResolvedValueOnce(undefined)
    const store = fakeStore({ describe, updateKeys })
    const log = vi.fn()

    await applyKvsRoute(
      store,
      { operation: 'put', kvsArn: KVS_ARN, key: 'k', value: 'v' },
      { sleep: noSleep, log },
    )

    expect(log).toHaveBeenCalledTimes(2)
    expect(log.mock.calls[0]?.[0]).toContain('k')
    expect(log.mock.calls[0]?.[0]).toContain('ValidationException')
    expect(log.mock.calls[0]?.[0]).toContain('attempt=1')
    expect(log.mock.calls[1]?.[0]).toContain('attempt 2')
  })

  it('uses the injected log instead of console.warn when given', async () => {
    const describe = vi.fn(async () => ({ etag: 'etag-x' }))
    const updateKeys = vi
      .fn()
      .mockRejectedValueOnce(conflictError())
      .mockResolvedValueOnce(undefined)
    const store = fakeStore({ describe, updateKeys })
    const log = vi.fn()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await applyKvsRoute(
      store,
      { operation: 'put', kvsArn: KVS_ARN, key: 'k', value: 'v' },
      { sleep: noSleep, log },
    )

    expect(log).toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})

const USER_POOL_ID = 'us-east-1_TestPool'
const SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:063257577013:secret:test-abc123'

function fakeDirectory(overrides: Partial<PoolUserDirectory> = {}): PoolUserDirectory {
  return {
    createUser: vi.fn(async () => undefined),
    setPassword: vi.fn(async () => undefined),
    deleteUser: vi.fn(async () => undefined),
    readPassword: vi.fn(async () => 'fake-password'),
    ...overrides,
  }
}

function usernameExistsError(): Error {
  const error = new Error('exists')
  error.name = 'UsernameExistsException'
  return error
}

function invalidParameterError(): Error {
  const error = new Error('invalid')
  error.name = 'InvalidParameterException'
  return error
}

function userNotFoundError(): Error {
  const error = new Error('not found')
  error.name = 'UserNotFoundException'
  return error
}

function resourceNotFoundError(): Error {
  const error = new Error('not found')
  error.name = 'ResourceNotFoundException'
  return error
}

function accessDeniedError2(): Error {
  const error = new Error('denied')
  error.name = 'AccessDeniedException'
  return error
}

describe('applyPoolUser', () => {
  it('on upsert, creates the user then reads the password then sets it, in that order', async () => {
    const calls: string[] = []
    const createUser = vi.fn(async () => {
      calls.push('createUser')
    })
    const readPassword = vi.fn(async () => {
      calls.push('readPassword')
      return 'secret-pw'
    })
    const setPassword = vi.fn(async () => {
      calls.push('setPassword')
    })
    const directory = fakeDirectory({ createUser, readPassword, setPassword })

    await applyPoolUser(directory, {
      operation: 'upsert',
      userPoolId: USER_POOL_ID,
      username: 'preview-bot',
      email: 'preview-bot@example.com',
      secretArn: SECRET_ARN,
      passwordKey: 'password',
    })

    expect(calls).toEqual(['createUser', 'readPassword', 'setPassword'])
    expect(createUser).toHaveBeenCalledWith({
      userPoolId: USER_POOL_ID,
      username: 'preview-bot',
      email: 'preview-bot@example.com',
    })
    // The password handed to setPassword must be the one readPassword supplied
    // — it must never be derived, hardcoded, or come from anywhere else, since
    // the whole design is that the password lives only in Secrets Manager.
    expect(setPassword).toHaveBeenCalledWith({
      userPoolId: USER_POOL_ID,
      username: 'preview-bot',
      password: 'secret-pw',
    })
  })

  it('treats an existing user (UsernameExistsException) as success and still re-sets the password', async () => {
    const createUser = vi.fn(async () => {
      throw usernameExistsError()
    })
    const readPassword = vi.fn(async () => 'rotated-pw')
    const setPassword = vi.fn(async () => undefined)
    const directory = fakeDirectory({ createUser, readPassword, setPassword })

    const id = await applyPoolUser(directory, {
      operation: 'upsert',
      userPoolId: USER_POOL_ID,
      username: 'preview-bot',
      email: 'preview-bot@example.com',
      secretArn: SECRET_ARN,
      passwordKey: 'password',
    })

    expect(id).toBe(`pooluser:${USER_POOL_ID}#preview-bot`)
    expect(readPassword).toHaveBeenCalledTimes(1)
    expect(setPassword).toHaveBeenCalledWith(
      expect.objectContaining({ password: 'rotated-pw' }),
    )
  })

  it('propagates a createUser failure that is not "already exists"', async () => {
    const createUser = vi.fn(async () => {
      throw invalidParameterError()
    })
    const readPassword = vi.fn(async () => 'pw')
    const setPassword = vi.fn(async () => undefined)
    const directory = fakeDirectory({ createUser, readPassword, setPassword })

    await expect(
      applyPoolUser(directory, {
        operation: 'upsert',
        userPoolId: USER_POOL_ID,
        username: 'preview-bot',
        email: 'preview-bot@example.com',
        secretArn: SECRET_ARN,
        passwordKey: 'password',
      }),
    ).rejects.toMatchObject({ name: 'InvalidParameterException' })

    expect(readPassword).not.toHaveBeenCalled()
    expect(setPassword).not.toHaveBeenCalled()
  })

  it('deletes the user', async () => {
    const deleteUser = vi.fn(async () => undefined)
    const directory = fakeDirectory({ deleteUser })

    const id = await applyPoolUser(directory, {
      operation: 'delete',
      userPoolId: USER_POOL_ID,
      username: 'preview-bot',
    })

    expect(deleteUser).toHaveBeenCalledWith({
      userPoolId: USER_POOL_ID,
      username: 'preview-bot',
    })
    expect(id).toBe(`pooluser:${USER_POOL_ID}#preview-bot`)
  })

  it('treats a delete against an already-gone user or pool as success', async () => {
    for (const error of [userNotFoundError(), resourceNotFoundError()]) {
      const deleteUser = vi.fn(async () => {
        throw error
      })
      const directory = fakeDirectory({ deleteUser })

      const id = await applyPoolUser(directory, {
        operation: 'delete',
        userPoolId: USER_POOL_ID,
        username: 'preview-bot',
      })

      expect(id).toBe(`pooluser:${USER_POOL_ID}#preview-bot`)
    }
  })

  it('propagates a delete failure that is not "already gone"', async () => {
    const deleteUser = vi.fn(async () => {
      throw accessDeniedError2()
    })
    const directory = fakeDirectory({ deleteUser })

    await expect(
      applyPoolUser(directory, {
        operation: 'delete',
        userPoolId: USER_POOL_ID,
        username: 'preview-bot',
      }),
    ).rejects.toMatchObject({ name: 'AccessDeniedException' })
  })

  it('throws before touching the directory when secretArn/passwordKey are missing on upsert', async () => {
    const directory = fakeDirectory()

    await expect(
      applyPoolUser(directory, {
        operation: 'upsert',
        userPoolId: USER_POOL_ID,
        username: 'preview-bot',
        email: 'preview-bot@example.com',
      }),
    ).rejects.toThrow('SecretArn and PasswordKey are required')

    expect(directory.createUser).not.toHaveBeenCalled()
    expect(directory.readPassword).not.toHaveBeenCalled()
    expect(directory.setPassword).not.toHaveBeenCalled()
    expect(directory.deleteUser).not.toHaveBeenCalled()
  })

  it('derives a physical resource id from pool + username, stable across upsert and delete', async () => {
    const upsertId = await applyPoolUser(fakeDirectory(), {
      operation: 'upsert',
      userPoolId: USER_POOL_ID,
      username: 'preview-bot',
      email: 'preview-bot@example.com',
      secretArn: SECRET_ARN,
      passwordKey: 'password',
    })
    const deleteId = await applyPoolUser(fakeDirectory(), {
      operation: 'delete',
      userPoolId: USER_POOL_ID,
      username: 'preview-bot',
    })

    expect(upsertId).toBe(`pooluser:${USER_POOL_ID}#preview-bot`)
    expect(upsertId).toBe(deleteId)
  })
})

const SESSION_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:063257577013:secret:session-abc123'

function fakeSecretReader(overrides: Partial<SecretReader> = {}): SecretReader {
  return {
    getSecretString: vi.fn(async () => '{"hmacKey":"super-secret-value"}'),
    ...overrides,
  }
}

describe('readSecretField', () => {
  it('reads the named field out of the secret JSON', async () => {
    const reader = fakeSecretReader()

    const value = await readSecretField(reader, {
      secretArn: SESSION_SECRET_ARN,
      field: 'hmacKey',
    })

    expect(value).toBe('super-secret-value')
  })

  it('fails, naming the secret, when there is no SecretString', async () => {
    const reader = fakeSecretReader({ getSecretString: vi.fn(async () => undefined) })

    await expect(
      readSecretField(reader, { secretArn: SESSION_SECRET_ARN, field: 'hmacKey' }),
    ).rejects.toThrow(new RegExp(`${SESSION_SECRET_ARN}.*SecretString`))
  })

  it('fails, naming the secret and the field, when the field is missing', async () => {
    const reader = fakeSecretReader({
      getSecretString: vi.fn(async () => '{"other":"value"}'),
    })

    await expect(
      readSecretField(reader, { secretArn: SESSION_SECRET_ARN, field: 'hmacKey' }),
    ).rejects.toThrow(new RegExp(`${SESSION_SECRET_ARN}.*hmacKey`))
  })

  it('fails, naming the secret and the field, when the field is non-string', async () => {
    const reader = fakeSecretReader({
      getSecretString: vi.fn(async () => '{"hmacKey":12345}'),
    })

    await expect(
      readSecretField(reader, { secretArn: SESSION_SECRET_ARN, field: 'hmacKey' }),
    ).rejects.toThrow(new RegExp(`${SESSION_SECRET_ARN}.*hmacKey`))
  })
})

describe('applyKvsSecret', () => {
  it('on put, reads the named field and writes it into the KVS under Key, using the ETag from describe', async () => {
    const describe = vi.fn(async () => ({ etag: 'etag-abc' }))
    const updateKeys = vi.fn(async () => undefined)
    const store = fakeStore({ describe, updateKeys })
    const reader = fakeSecretReader()

    const id = await applyKvsSecret(
      store,
      reader,
      {
        operation: 'put',
        kvsArn: KVS_ARN,
        key: 'session-secret',
        secretArn: SESSION_SECRET_ARN,
        secretKey: 'hmacKey',
      },
      { sleep: noSleep },
    )

    expect(reader.getSecretString).toHaveBeenCalledWith(SESSION_SECRET_ARN)
    expect(updateKeys).toHaveBeenCalledWith({
      kvsArn: KVS_ARN,
      ifMatch: 'etag-abc',
      puts: [{ key: 'session-secret', value: 'super-secret-value' }],
    })
    expect(id).toBe(`kvsroute:${KVS_ARN}#session-secret`)
  })

  it('on delete, removes the key without touching the secret reader', async () => {
    const describe = vi.fn(async () => ({ etag: 'etag-abc' }))
    const updateKeys = vi.fn(async () => undefined)
    const store = fakeStore({ describe, updateKeys })
    const reader = fakeSecretReader()

    const id = await applyKvsSecret(
      store,
      reader,
      { operation: 'delete', kvsArn: KVS_ARN, key: 'session-secret' },
      { sleep: noSleep },
    )

    expect(reader.getSecretString).not.toHaveBeenCalled()
    expect(updateKeys).toHaveBeenCalledWith({
      kvsArn: KVS_ARN,
      ifMatch: 'etag-abc',
      deletes: [{ key: 'session-secret' }],
    })
    expect(id).toBe(`kvsroute:${KVS_ARN}#session-secret`)
  })

  it('treats a delete of a key that is not there as success', async () => {
    const describe = vi.fn(async () => ({ etag: 'etag-x' }))
    const updateKeys = vi.fn().mockRejectedValueOnce(notFoundError())
    const store = fakeStore({ describe, updateKeys })
    const reader = fakeSecretReader()

    const id = await applyKvsSecret(
      store,
      reader,
      { operation: 'delete', kvsArn: KVS_ARN, key: 'session-secret' },
      { sleep: noSleep },
    )

    expect(id).toBe(`kvsroute:${KVS_ARN}#session-secret`)
    expect(updateKeys).toHaveBeenCalledTimes(1)
  })

  it('fails, naming the secret and the field, when the secret has no SecretString', async () => {
    const store = fakeStore()
    const reader = fakeSecretReader({ getSecretString: vi.fn(async () => undefined) })

    await expect(
      applyKvsSecret(
        store,
        reader,
        {
          operation: 'put',
          kvsArn: KVS_ARN,
          key: 'session-secret',
          secretArn: SESSION_SECRET_ARN,
          secretKey: 'hmacKey',
        },
        { sleep: noSleep },
      ),
    ).rejects.toThrow(new RegExp(`${SESSION_SECRET_ARN}.*SecretString`))
    expect(store.updateKeys).not.toHaveBeenCalled()
  })

  it('fails, naming the secret and the field, when the named field is missing or non-string', async () => {
    const store = fakeStore()

    const missing = fakeSecretReader({
      getSecretString: vi.fn(async () => '{"other":"value"}'),
    })
    await expect(
      applyKvsSecret(
        store,
        missing,
        {
          operation: 'put',
          kvsArn: KVS_ARN,
          key: 'session-secret',
          secretArn: SESSION_SECRET_ARN,
          secretKey: 'hmacKey',
        },
        { sleep: noSleep },
      ),
    ).rejects.toThrow(new RegExp(`${SESSION_SECRET_ARN}.*hmacKey`))

    const nonString = fakeSecretReader({
      getSecretString: vi.fn(async () => '{"hmacKey":12345}'),
    })
    await expect(
      applyKvsSecret(
        store,
        nonString,
        {
          operation: 'put',
          kvsArn: KVS_ARN,
          key: 'session-secret',
          secretArn: SESSION_SECRET_ARN,
          secretKey: 'hmacKey',
        },
        { sleep: noSleep },
      ),
    ).rejects.toThrow(new RegExp(`${SESSION_SECRET_ARN}.*hmacKey`))

    expect(store.updateKeys).not.toHaveBeenCalled()
  })

  it('retries a write that fails once with ValidationException then succeeds — the shared applyKvsRoute path', async () => {
    let call = 0
    const describe = vi.fn(async () => {
      call += 1
      return { etag: `etag-${call}` }
    })
    const updateKeys = vi
      .fn()
      .mockRejectedValueOnce(validationError())
      .mockResolvedValueOnce(undefined)
    const store = fakeStore({ describe, updateKeys })
    const reader = fakeSecretReader()

    const id = await applyKvsSecret(
      store,
      reader,
      {
        operation: 'put',
        kvsArn: KVS_ARN,
        key: 'session-secret',
        secretArn: SESSION_SECRET_ARN,
        secretKey: 'hmacKey',
      },
      { sleep: noSleep },
    )

    expect(id).toBe(`kvsroute:${KVS_ARN}#session-secret`)
    expect(describe).toHaveBeenCalledTimes(2)
    expect(updateKeys).toHaveBeenCalledTimes(2)
    expect(updateKeys).toHaveBeenNthCalledWith(1, expect.objectContaining({ ifMatch: 'etag-1' }))
    expect(updateKeys).toHaveBeenNthCalledWith(2, expect.objectContaining({ ifMatch: 'etag-2' }))
  })

  it('throws before reading the secret when secretArn/secretKey are missing on put', async () => {
    const store = fakeStore()
    const reader = fakeSecretReader()

    await expect(
      applyKvsSecret(
        store,
        reader,
        { operation: 'put', kvsArn: KVS_ARN, key: 'session-secret' },
        { sleep: noSleep },
      ),
    ).rejects.toThrow('SecretArn and SecretKey are required')

    expect(reader.getSecretString).not.toHaveBeenCalled()
    expect(store.describe).not.toHaveBeenCalled()
  })
})

describe('handler', () => {
  it('throws on an unknown ResourceType', async () => {
    const event = {
      RequestType: 'Create',
      ResourceProperties: { ResourceType: 'SomethingElse' },
      // The remaining CloudFormation custom-resource-event fields are
      // untouched by `handler` before the unknown-type throw fires, so they
      // are omitted here.
    } as unknown as Parameters<typeof handler>[0]

    await expect(handler(event)).rejects.toThrow(/unknown ResourceType/)
  })
})
