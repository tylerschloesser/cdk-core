import { describe, expect, it, vi } from 'vitest'
import { applyKvsRoute, applyPoolUser } from '../src/handlers/preview-resources.js'
import type { KvsStore, PoolUserDirectory } from '../src/handlers/preview-resources.js'

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
