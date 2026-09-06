import { describe, expect, it, vi } from 'vitest'
import { applyKvsRoute } from '../src/handlers/preview-resources.js'
import type { KvsStore } from '../src/handlers/preview-resources.js'

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
