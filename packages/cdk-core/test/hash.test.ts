import { describe, expect, it } from 'vitest'
import { EMPTY_BODY_SHA256, sha256Hex } from '../src/hash.js'

describe('sha256Hex', () => {
  it('hashes the empty string to the SigV4 empty-payload constant', async () => {
    // If these two ever disagree, every POST through CloudFront 403s.
    expect(await sha256Hex('')).toBe(EMPTY_BODY_SHA256)
  })

  it('matches a known vector', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('hashes a Uint8Array and an equivalent string identically', async () => {
    const bytes = new TextEncoder().encode('hello world')
    expect(await sha256Hex(bytes)).toBe(await sha256Hex('hello world'))
  })

  it('honours byteOffset and byteLength on a view into a larger buffer', async () => {
    const big = new Uint8Array([9, 1, 2, 3, 9, 9])
    const slice = new Uint8Array(big.buffer, 1, 3)
    expect(await sha256Hex(slice)).toBe(await sha256Hex(new Uint8Array([1, 2, 3])))
  })

  it('hashes an ArrayBuffer the same as a Uint8Array view over it', async () => {
    const bytes = new Uint8Array([1, 2, 3])
    expect(await sha256Hex(bytes.buffer)).toBe(await sha256Hex(bytes))
  })

  it('produces 64 lowercase hex characters', async () => {
    const hex = await sha256Hex('anything')
    expect(hex).toMatch(/^[0-9a-f]{64}$/)
  })
})
